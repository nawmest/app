# Test fixtures

`head.png` is a rendering of the "Lee Perry-Smith" head scan by
[Infinite-Realities](https://www.ir-ltd.net/), licensed under
[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/), as distributed
with the three.js examples (`examples/models/gltf/LeePerrySmith`). It is used only by the
automated tests: the fake front camera (`e2e/fake-front-camera.js`) animates it with a synthetic
pulse of known rate so the measured heart rate can be checked. No real measurement of any person
is involved.
