export class CameraError extends Error {}

/** Opens the front (selfie) camera in the given video element. */
export async function startFrontCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!window.isSecureContext) {
    throw new CameraError('Camera access needs a secure (https://) page. Open the app over HTTPS.');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('This browser does not support camera access.');
  }
  // 960x720 keeps the preview sharp while costing less to analyse than HD. The pulse needs frames
  // more than pixels: in dim light phone cameras halve their frame rate for longer exposures
  // unless asked to keep at least 24 fps (if the camera can't, fall back to anything).
  const constraints = (frameRate: MediaTrackConstraints['frameRate']): MediaStreamConstraints => ({
    audio: false,
    video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 720 }, frameRate },
  });
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices
      .getUserMedia(constraints({ ideal: 30, min: 24 }))
      .catch((e: DOMException) => (e?.name === 'OverconstrainedError' ? navigator.mediaDevices.getUserMedia(constraints({ ideal: 30 })) : Promise.reject(e)));
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === 'NotAllowedError') throw new CameraError('Camera access was blocked. Allow camera access for this page in your browser settings.');
    if (name === 'NotFoundError') throw new CameraError('No front camera was found on this device.');
    throw new CameraError(`Could not open the camera (${name ?? e}).`);
  }
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  await video.play();
  if (!video.videoWidth) {
    await new Promise<void>((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
  }
  return stream;
}

export function stopCamera(video: HTMLVideoElement): void {
  (video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}
