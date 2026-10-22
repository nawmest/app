/**
 * Alternative video source for places where the live camera is unavailable (embedded previews,
 * desktop browsers without a camera): a recorded or picked video file.
 */

/** Plays a local video file (on phones the picker can record one with the camera). */
export async function startVideoFile(video: HTMLVideoElement, file: File): Promise<void> {
  const old = video.src;
  video.srcObject = null;
  video.src = URL.createObjectURL(file);
  if (old.startsWith('blob:')) URL.revokeObjectURL(old);
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  await new Promise<void>((resolve, reject) => {
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(new Error('This video format cannot be played here. Try an MP4 file.')), {
      once: true,
    });
  });
  await video.play();
}
