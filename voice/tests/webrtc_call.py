"""End-to-end WebRTC check of the call server, the same path the companion app uses.

A Python WebRTC client (aiortc) dials the running server, speaks a recorded question after a few
seconds, records everything Bookwyrm says back, and hangs up.

    python tests/webrtc_call.py question.wav --out reply.wav --seconds 40
"""

from __future__ import annotations

import argparse
import asyncio

import httpx
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaPlayer, MediaRecorder


async def main(question: str, out: str, seconds: float, server: str):
    pc = RTCPeerConnection()
    player = MediaPlayer(question)
    pc.addTrack(player.audio)
    recorder = MediaRecorder(out)

    @pc.on("track")
    def on_track(track):
        if track.kind == "audio":
            recorder.addTrack(track)

    pc.createDataChannel("chat")  # the app's client opens one for captions; mirror it
    await pc.setLocalDescription(await pc.createOffer())
    while pc.iceGatheringState != "complete":
        await asyncio.sleep(0.05)
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{server}/api/offer", json={"sdp": pc.localDescription.sdp, "type": pc.localDescription.type})
        r.raise_for_status()
        ans = r.json()
    await pc.setRemoteDescription(RTCSessionDescription(sdp=ans["sdp"], type=ans["type"]))
    await recorder.start()
    print(f"connected (pc_id {ans.get('pc_id')}); recording {seconds:.0f}s")
    await asyncio.sleep(seconds)
    await recorder.stop()
    await pc.close()
    print(f"saved {out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("question")
    ap.add_argument("--out", default="reply.wav")
    ap.add_argument("--seconds", type=float, default=40)
    ap.add_argument("--server", default="http://127.0.0.1:7865")
    a = ap.parse_args()
    asyncio.run(main(a.question, a.out, a.seconds, a.server))
