// A minimal WebRTC call to the Bookwyrm voice service: no third-party client, no runtime downloads.
//
// - The microphone is opened with the browser's echo cancellation, noise suppression and
//   automatic gain on: echo cancellation is what stops Bookwyrm hearing itself on laptop speakers.
// - Audio goes both ways over one peer connection; captions and speaking state arrive as RTVI
//   messages on a data channel.

const RTVI = "rtvi-ai";

export class Call {
  constructor({ url, requestData = {}, onMessage = () => {}, onLevel = () => {}, onDrop = () => {} }) {
    this.url = url;
    this.requestData = requestData;
    this.onMessage = onMessage;
    this.onLevel = onLevel;
    this.onDrop = onDrop;
    this.pc = null;
    this.mic = null;
    this.channel = null;
    this.audio = null;
    this.ctx = null;
    this.levelTimer = null;
    this.closed = false;
  }

  async start(audioElement) {
    this.audio = audioElement;
    this.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    const pc = (this.pc = new RTCPeerConnection());
    pc.addTransceiver(this.mic.getAudioTracks()[0], { direction: "sendrecv" });
    pc.addTransceiver("video", { direction: "recvonly" });   // the server's SDP expects a video m-line

    this.channel = pc.createDataChannel("chat", { ordered: true });
    this.channel.onopen = () => this.send("client-ready", { version: "1.0.0", about: { library: "bookwyrm-app" } });
    this.channel.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.label === RTVI) {
          (window.__rtvi ??= []).push(msg);           // last messages, for debugging
          if (window.__rtvi.length > 200) window.__rtvi.shift();
          this.onMessage(msg.type, msg.data || {});
        }
      } catch {}
    };

    pc.ontrack = (e) => {
      if (e.track.kind !== "audio") return;
      const stream = new MediaStream([e.track]);
      this.audio.srcObject = stream;
      this.audio.play().catch(() => {});
      this.meter(stream);
    };
    pc.onconnectionstatechange = () => {
      if (!this.closed && ["failed", "disconnected", "closed"].includes(pc.connectionState)) this.onDrop();
    };

    await pc.setLocalDescription(await pc.createOffer());
    await this.iceGathered();
    const r = await fetch(`${this.url}/api/offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: pc.localDescription.sdp, type: pc.localDescription.type, requestData: this.requestData }),
    });
    if (!r.ok) throw new Error(`voice service answered ${r.status}`);
    const answer = await r.json();
    await pc.setRemoteDescription({ sdp: answer.sdp, type: answer.type });
  }

  iceGathered() {
    if (this.pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { if (this.pc.iceGatheringState === "complete") resolve(); };
      this.pc.addEventListener("icegatheringstatechange", done);
      setTimeout(resolve, 2000);   // local-only call; host candidates arrive almost at once
    });
  }

  meter(stream) {
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(stream);
    const an = this.ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    this.levelTimer = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      this.onLevel(Math.sqrt(sum / buf.length));
    }, 50);
  }

  send(type, data) {
    if (this.channel?.readyState === "open") {
      this.channel.send(JSON.stringify({ label: RTVI, type, id: crypto.randomUUID(), data }));
    }
  }

  sendText(content) {
    this.send("send-text", { content, options: { run_immediately: true, audio_response: true } });
  }

  setMuted(muted) {
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  hangup() {
    this.closed = true;
    clearInterval(this.levelTimer);
    this.ctx?.close().catch(() => {});
    this.mic?.getTracks().forEach((t) => t.stop());
    this.channel?.close();
    this.pc?.close();
    if (this.audio) this.audio.srcObject = null;
  }
}
