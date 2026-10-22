# PulseLens

An AR health check in the browser. PulseLens scans your face with the phone's **front camera**
for 30 seconds and measures **heart rate**, **breathing rate** and, when the signal allows,
**heart rate variability (HRV)**. The readings float beside your face in an AR overlay while a
face-mesh scan animation runs.

| Start | Results |
| --- | --- |
| ![intro](docs/intro.jpg) | ![results](docs/results.jpg) |

<sub>Screenshots from the automated test, which uses a synthetic camera with a simulated 78 bpm pulse.</sub>

> **Not a medical device.** PulseLens is a wellness demo. Its estimates must not be used for
> diagnosis or treatment.

## How it works

With every heartbeat, the blood volume in the skin's capillaries changes a little, which changes
how much light the skin absorbs, mostly in green. A camera can see this as a colour change of
well under 1%. Recovering a pulse from it is called **remote photoplethysmography (rPPG)**.

```
front camera ─► MediaPipe Face Landmarker (478-point face mesh, on-device)
                 │
                 ├─► measurement regions: forehead + both cheeks (convex hulls of mesh points)
                 │     └─► mean skin colour per frame (over-exposed and very dark pixels skipped)
                 │           └─► resample to 30 Hz ─► POS algorithm ─► band-pass 0.65–3.5 Hz
                 │                 ├─► spectrum peak (+ SNR) ─► heart rate, signal quality
                 │                 └─► steepest upstroke of each beat ─► beat times ─► HRV (RMSSD)
                 ├─► head motion + slow colour baseline ─► band-pass 0.1–0.6 Hz ─► breathing rate
                 └─► face size, position, angle, motion, light ─► live guidance
```

* **Face tracking** (`src/face/`): MediaPipe Face Landmarker runs on the GPU, falling back to the
  CPU, with the runtime and model self-hosted. It gives a 478-point mesh and the head angle.
* **Regions** (`src/face/regions.ts`): the forehead (including the glabella) and both cheeks.
  Studies consistently find these give the strongest, steadiest rPPG signal: they are flat,
  well lit and have little muscle movement. Eyes, brows, lips and hair are excluded.
* **Pulse extraction** (`src/rppg/pos.ts`): POS, "Plane-Orthogonal-to-Skin" (Wang, den Brinker,
  Stuijk & de Haan, IEEE TBME 2017). Colour is normalised over 1.6 s windows and projected onto
  a plane orthogonal to the skin tone, which cancels most brightness and specular changes from
  motion and lighting. In benchmarks, POS and CHROM are among the most robust classic methods.
* **Heart rate** (`src/rppg/estimator.ts`, `dsp.ts`): zero-phase Butterworth band-pass, Hann-
  windowed FFT over a 10 s window, and a parabolic peak. A sub-harmonic check stops the strong
  second harmonic of a pulse wave being read as double the rate. The signal-to-noise ratio
  (de Haan's definition) becomes a confidence score, and each new estimate is smoothed in
  proportion to its quality.
* **HRV** is only reported when the pulse SNR is at least 5 dB. Tests show that below that,
  beat-timing noise roughly doubles RMSSD, so the app says "needs a steadier signal" instead of
  showing a wrong number.
* **Breathing** comes from the slight up-and-down head motion and the slow colour baseline
  (respiratory-induced intensity variation), whichever has the cleaner spectrum.
* **Guidance and safety nets** (`src/scan.ts`): the scan only starts once the face is centred,
  close enough, facing the camera, still and well lit. During the scan, losing the face pauses
  it, and other problems lower the quality score and show a hint. If the analysed frame rate
  falls below 5 fps (where a pulse would alias to a wrong rate), measuring pauses. Between 5 and
  8 fps the heart-rate search is limited to what that rate can represent.
* **AR layer** (`src/ui/fx.ts`): a canvas over the mirrored video draws the alignment dial, the
  face mesh with a sweeping scan band, the face contour, lock-on brackets, a segmented progress
  ring around the face, and measurement regions that glow with each heartbeat. Glass metric cards
  ride beside the face with leader lines to it. A **performance governor** drops the glass blur
  and mesh detail, then animation rate, on slow devices, so measurement always gets the CPU
  first.

### Privacy

Everything runs in the browser. Video frames are analysed on the device and never uploaded. The
face model, the MediaPipe runtime and the font are served with the app, so it makes no
third-party requests.

### Accuracy and limitations

* Motion, poor or flickering light (some LED and fluorescent lamps), strong backlight, heavy
  makeup and auto-exposure changes all reduce accuracy. The quality score reflects this.
* Published camera-based heart-rate errors are typically a few bpm at rest under good
  conditions, and much worse with motion. HRV is more fragile than heart rate. Breathing estimates
  assume you sit still and breathe normally.
* The reference ranges shown are general adult resting ranges, not personal advice.

### Research consulted

* Wang et al., *Algorithmic Principles of Remote PPG* (POS), IEEE TBME 2017; comparisons in
  [rPPG in the wild via online webcams](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11362249/),
  [Frontiers in Physiology 2023](https://www.frontiersin.org/journals/physiology/articles/10.3389/fphys.2023.1296277/pdf),
  [Diverse R-PPG](https://arxiv.org/pdf/2010.12769).
* Region choice: [Po et al., ICASSP 2015](https://www.ee.cityu.edu.hk/~lmpo/publications/2015_ICASSP_rPPG.pdf),
  [ROI review (PMC8659899)](https://pmc.ncbi.nlm.nih.gov/articles/PMC8659899),
  [facial surface orientation, CVPRW 2022](https://mlanthology.org/cvprw/2022/wong2022cvprw-optimising).
* Breathing and HRV from cameras: [front-camera respiratory rate (medRxiv)](https://www.medrxiv.org/content/medrxiv/early/2021/03/12/2021.03.08.21252408.full.pdf),
  [contactless HRV with a smartphone](https://pure.skku.edu/en/publications/contactless-heart-rate-variability-hrv-estimation-using-a-smartph/).
* [MediaPipe Face Landmarker for Web](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js).

## Development

```bash
npm install
npm run dev        # HTTPS dev server on your LAN (self-signed cert): open https://<your-ip>:5173 on the phone
npm test           # signal-processing tests on simulated skin-colour signals
npm run build      # production build in dist/ (copies the MediaPipe runtime into dist/mediapipe)
npm run e2e        # browser test with a synthetic front camera (after npm run build)
```

The camera needs a secure context (`https://` or `http://localhost`). `?delegate=cpu` forces
MediaPipe's CPU path (used by the headless test, whose GPU is emulated).

### Tests

* `tests/rppg.test.ts` simulates the mean skin colour of a face: a realistic pulse wave with
  beat-to-beat variability, breathing, lighting flicker, noise and jittery frame timing. It checks
  heart rate at 55–125 bpm (within 2.5 bpm), that pure brightness flicker is not mistaken for a
  pulse, HRV against the true beat intervals, the HRV quality gate and the breathing rate.
* `e2e/run.mjs` runs the built app in Chromium with `e2e/fake-front-camera.js`, a synthetic front
  camera filming a rendered head whose skin pulses at a known rate (default 78 bpm, `BPM=90` to
  change), with natural sway and breathing motion. It checks the no-face guidance, alignment,
  live readings, the final heart rate (±5 bpm) and the results screen. In this environment the
  result was 77–78 bpm and breathing 15.0/min against 15 simulated.

### Deploying

`.github/workflows/deploy.yml` type-checks, tests and builds on every push, and publishes `dist/`
to GitHub Pages from the default branch.

## Credits

* [MediaPipe](https://github.com/google-ai-edge/mediapipe) Face Landmarker runtime and model,
  Google, Apache 2.0 (see `public/models/README.md`).
* [Inter](https://rsms.me/inter/) typeface by Rasmus Andersson, SIL Open Font License, via
  Fontsource.
* Test fixture: rendering of the Lee Perry-Smith head scan by Infinite-Realities, CC BY 3.0
  (see `e2e/fixtures/README.md`). It is used only by the automated tests.
