export class CameraError extends Error {}

/** Opens the front (selfie) camera in the given video element. */
export async function startFrontCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!window.isSecureContext) {
    throw new CameraError('Camera access needs a secure (https://) page. Open the app over HTTPS.');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('This browser does not support camera access.');
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    });
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
