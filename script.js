// Fungsi untuk mengonversi Base64 ke ArrayBuffer
function base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

// Fungsi penulisan string ke DataView (untuk header WAV)
function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

// Fungsi penting: Mengonversi data mentah PCM 16-bit dari API menjadi format file WAV
function pcmToWav(pcm16Array, sampleRate) {
    const numChannels = 1; // API Gemini mengembalikan audio Mono
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const dataSize = pcm16Array.byteLength;
    
    // Header WAV membutuhkan 44 byte
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // RIFF chunk descriptor
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true); // ChunkSize
    writeString(view, 8, 'WAVE');
    
    // fmt sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true);  // AudioFormat (1 for PCM)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    
    // data sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true); // Subchunk2Size

    // Menyalin data PCM ke dalam buffer WAV
    const pcmView = new Uint8Array(buffer, 44);
    pcmView.set(new Uint8Array(pcm16Array.buffer));

    return new Blob([buffer], { type: 'audio/wav' });
}

function pcmToMp3(pcm16Array, sampleRate) {
    const mp3encoder = new lamejs.Mp3Encoder(1, sampleRate, 128); // Mono, Sample Rate, 128kbps
    const mp3Data = [];
    
    const sampleBlockSize = 1152; // LAME memproses blok kelipatan 1152
    
    for (let i = 0; i < pcm16Array.length; i += sampleBlockSize) {
        const sampleChunk = pcm16Array.subarray(i, i + sampleBlockSize);
        const mp3buf = mp3encoder.encodeBuffer(sampleChunk);
        if (mp3buf.length > 0) {
            mp3Data.push(mp3buf);
        }
    }
    
    const mp3buf = mp3encoder.flush(); // Flush sisa buffer
    if (mp3buf.length > 0) {
        mp3Data.push(mp3buf);
    }
    
    return new Blob(mp3Data, { type: 'audio/mp3' });
}

const apiKey = ""; // Otomatis disuntikkan oleh sistem canvas/environment

document.getElementById('generate-btn').addEventListener('click', async () => {
    const narasi = document.getElementById('narration').value.trim();
    const emotion = document.getElementById('emotion').value;
    const voiceElement = document.getElementById('voice-model');
    const voiceName = voiceElement.value;
    const voiceLabel = voiceElement.options[voiceElement.selectedIndex].text;
    
    const btn = document.getElementById('generate-btn');
    const btnText = document.getElementById('btn-text');
    const btnLoader = document.getElementById('btn-loader');
    const errorMsg = document.getElementById('error-message');
    const outputSection = document.getElementById('output-section');
    const audioPlayer = document.getElementById('audio-player');
    const downloadBtn = document.getElementById('download-btn');

    // Validasi Input
    if (!narasi) {
        showError("Mohon masukkan teks narasi terlebih dahulu.");
        return;
    }

    // Reset UI State
    errorMsg.classList.add('hidden');
    outputSection.classList.add('hidden');
    btn.disabled = true;
    btn.classList.add('opacity-75', 'cursor-not-allowed');
    btnText.textContent = "Memproses...";
    btnLoader.classList.remove('hidden');

    // Menyusun instruksi ke model.
    // Kita memberitahu AI untuk merespon dalam bahasa Indonesia dengan sangat natural layaknya manusia sungguhan.
    const promptText = `Bacakan narasi berikut dalam bahasa Indonesia dengan intonasi yang sangat natural, layaknya manusia sungguhan yang sedang berbicara dan bernapas (bukan robot). Gunakan vibe dan emosi yang ${emotion}. Karakter suara kamu adalah ${voiceLabel}:\n\n"${narasi}"`;

    const payload = {
        contents: [{
            parts: [{ text: promptText }]
        }],
        generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: voiceName }
                }
            }
        },
        model: "gemini-2.5-flash-preview-tts"
    };

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;

    try {
        // Mekanisme Exponential Backoff sederhana untuk mengatasi throttling
        let response = null;
        let retries = 3;
        let delay = 1000;

        for (let i = 0; i < retries; i++) {
            response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.ok) break;
            
            if (response.status === 429) {
                await new Promise(r => setTimeout(r, delay));
                delay *= 2;
            } else {
                break;
            }
        }

        if (!response || !response.ok) {
            throw new Error(`Gagal memproses data dari server. (Status: ${response?.status || 'Unknown'})`);
        }

        const result = await response.json();
        const part = result?.candidates?.[0]?.content?.parts?.[0];
        const audioBase64 = part?.inlineData?.data;
        const mimeType = part?.inlineData?.mimeType;

        if (audioBase64 && mimeType && mimeType.startsWith("audio/")) {
            // Ekstrak sample rate dari mimetype (contoh: "audio/pcm;rate=24000")
            const sampleRateMatch = mimeType.match(/rate=(\d+)/);
            const sampleRate = sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : 24000;

            // Dekonversi dari base64 ke buffer PCM 16-bit
            const pcmData = base64ToArrayBuffer(audioBase64);
            const pcm16Array = new Int16Array(pcmData);
            
            // Konversi PCM ke MP3 File Blob
            const mp3Blob = pcmToMp3(pcm16Array, sampleRate);
            
            // Buat Object URL untuk memutar dan mengunduh
            const audioUrl = URL.createObjectURL(mp3Blob);

            // Tampilkan di UI
            audioPlayer.src = audioUrl;
            downloadBtn.href = audioUrl;
            
            // Generate nama file unik dengan ekstensi .mp3
            const dateStr = new Date().toISOString().slice(0,10);
            downloadBtn.download = `SuaraAI_${voiceName}_${dateStr}.mp3`;
            
            outputSection.classList.remove('hidden');
        } else {
            throw new Error("Format audio tidak sesuai atau tidak dikembalikan oleh server.");
        }

    } catch (error) {
        showError("Terjadi kesalahan: " + error.message);
    } finally {
        // Restore Button State
        btn.disabled = false;
        btn.classList.remove('opacity-75', 'cursor-not-allowed');
        btnText.textContent = "Hasilkan Suara AI";
        btnLoader.classList.add('hidden');
    }
});

function showError(message) {
    const errorMsg = document.getElementById('error-message');
    errorMsg.textContent = message;
    errorMsg.classList.remove('hidden');
    setTimeout(() => {
        errorMsg.classList.add('hidden');
    }, 8000); // Sembunyikan otomatis setelah 8 detik
}

// FITUR BARU: Generate Video MP4 (Audio + Visualizer) menggunakan MediaRecorder API
document.getElementById('download-mp4-btn').addEventListener('click', async () => {
    const audioPlayer = document.getElementById('audio-player');
    if (!audioPlayer.src) return;

    const btn = document.getElementById('download-mp4-btn');
    const originalContent = btn.innerHTML;
    const canvas = document.getElementById('visualizer');
    const statusText = document.getElementById('recording-status');
    const ctx = canvas.getContext('2d');

    // Set UI State
    btn.innerHTML = `<div class="loader w-4 h-4 mr-2 border-2 border-white border-t-transparent"></div> Merekam...`;
    btn.disabled = true;
    btn.classList.add('opacity-75', 'cursor-not-allowed');
    canvas.classList.remove('hidden');
    statusText.classList.remove('hidden');

    try {
        // Setup AudioContext
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        
        // Ambil data audio dari Blob URL yang sudah ada
        const response = await fetch(audioPlayer.src);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        const dest = audioCtx.createMediaStreamDestination();
        
        // Routing: Source -> Analyser -> Destination 
        // (TIDAK disalurkan ke speaker utama agar tidak berisik saat direkam)
        source.connect(analyser);
        analyser.connect(dest);
        
        // Ambil stream video dari Canvas (30 FPS)
        const canvasStream = canvas.captureStream(30);
        
        // Gabungkan track video dan track audio
        const combinedStream = new MediaStream([
            ...canvasStream.getVideoTracks(),
            ...dest.stream.getAudioTracks()
        ]);
        
        // Deteksi format (Chrome akan fallback ke WebM, Safari mendukung MP4 native)
        let options = { mimeType: 'video/webm' };
        let ext = 'webm';
        if (MediaRecorder.isTypeSupported('video/mp4')) {
            options = { mimeType: 'video/mp4' };
            ext = 'mp4';
        }

        const recorder = new MediaRecorder(combinedStream, options);
        const chunks = [];
        
        recorder.ondataavailable = (e) => {
            if (e.data.size > 0) chunks.push(e.data);
        };
        
        recorder.onstop = () => {
            const blob = new Blob(chunks, { type: options.mimeType });
            const url = URL.createObjectURL(blob);
            
            // Trigger download otomatis
            const a = document.createElement('a');
            a.href = url;
            const dateStr = new Date().toISOString().slice(0,10);
            a.download = `SuaraAI_Visualizer_${dateStr}.${ext}`;
            a.click();
            
            // Kembalikan UI ke semula
            btn.innerHTML = originalContent;
            btn.disabled = false;
            btn.classList.remove('opacity-75', 'cursor-not-allowed');
            canvas.classList.add('hidden');
            statusText.classList.add('hidden');
            audioCtx.close();
        };
        
        // Loop Animasi Visualizer
        function draw() {
            if (recorder.state === 'inactive') return;
            requestAnimationFrame(draw);
            
            analyser.getByteFrequencyData(dataArray);
            
            // Background elegan (biru gelap ke hitam)
            const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
            gradient.addColorStop(0, '#0f172a'); // slate-900
            gradient.addColorStop(1, '#1e3a8a'); // blue-900
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            const barWidth = (canvas.width / bufferLength) * 2;
            let barHeight;
            let x = 0;
            
            // Gambar gelombang suara
            for(let i = 0; i < bufferLength; i++) {
                barHeight = dataArray[i] * 2.2; // Pengali tinggi gelombang
                
                // Warna neon gradient
                const r = barHeight + 50 > 255 ? 255 : barHeight + 50;
                const g = 100;
                const b = 255 - (barHeight/2);
                
                ctx.fillStyle = `rgb(${r},${g},${b})`;
                
                // Posisi simetris di tengah
                const y = (canvas.height / 2) - (barHeight / 2);
                ctx.fillRect(x, y, barWidth, barHeight);
                
                x += barWidth + 2;
            }
        }
        
        // Mulai rekam dan jalankan audio
        recorder.start();
        source.start(0);
        draw();
        
        // Berhenti merekam secara otomatis saat durasi audio habis
        source.onended = () => {
            recorder.stop();
        };
        
    } catch (err) {
        console.error(err);
        alert("Gagal merender video: " + err.message);
        btn.innerHTML = originalContent;
        btn.disabled = false;
        btn.classList.remove('opacity-75', 'cursor-not-allowed');
        canvas.classList.add('hidden');
        statusText.classList.add('hidden');
    }
});