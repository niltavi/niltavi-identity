# Vendored Niltavi Banner

`screenprint.js` comes from [niltavi-banner](https://github.com/niltavi/niltavi-banner) at commit `a0d8d9f`. It is licensed under MIT. See [LICENSE](LICENSE).

When updating from `src/screenprint.js`, keep the unconditional `globalThis.NiltaviBanner` assignment. Identity's browser build can select the CommonJS export while its banner component reads the global.
