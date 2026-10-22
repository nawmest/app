import { type GrayImage, createGray, rgbaToGray } from './vision/image';

export class CameraError extends Error {}

/** Opens the rear camera and starts playback in the given video element. */
export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
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
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    });
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === 'NotAllowedError') throw new CameraError('Camera access was blocked. Allow camera access for this page in your browser settings.');
    if (name === 'NotFoundError') throw new CameraError('No camera was found on this device.');
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
  const stream = video.srcObject as MediaStream | null;
  stream?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

/** Downscales video frames to the processing resolution and converts them to grayscale. */
export class FrameGrabber {
  readonly width: number;
  readonly height: number;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly gray: GrayImage;

  constructor(videoWidth: number, videoHeight: number, maxSide = 480) {
    const s = Math.min(1, maxSide / Math.max(videoWidth, videoHeight));
    this.width = Math.round(videoWidth * s);
    this.height = Math.round(videoHeight * s);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.gray = createGray(this.width, this.height);
  }

  grab(video: HTMLVideoElement): GrayImage {
    this.ctx.drawImage(video, 0, 0, this.width, this.height);
    const { data } = this.ctx.getImageData(0, 0, this.width, this.height);
    return rgbaToGray(data, this.gray);
  }
}
