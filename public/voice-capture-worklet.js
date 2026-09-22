class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = [];
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let energy = 0;
    for (const sample of channel) {
      energy += sample * sample;
      this.sum += sample;
      this.count++;
      this.phase += 16000 / sampleRate;
      if (this.phase >= 1) {
        this.samples.push(
          Math.max(
            -32768,
            Math.min(32767, Math.round((this.sum / this.count) * 32767)),
          ),
        );
        this.phase -= 1;
        this.sum = 0;
        this.count = 0;
      }
      if (this.samples.length === 320) {
        const pcm = new Int16Array(this.samples);
        this.samples = [];
        this.port.postMessage({ pcm: pcm.buffer }, [pcm.buffer]);
      }
    }
    this.port.postMessage({ rms: Math.sqrt(energy / channel.length) });
    return true;
  }
}
registerProcessor("voice-capture", VoiceCapture);
