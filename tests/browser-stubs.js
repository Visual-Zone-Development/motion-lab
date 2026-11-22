// Just enough of the browser for the game's modules to load under `node --test`: gfx.js asks
// for its fonts when it's imported. Drawing isn't tested here.
globalThis.FontFace ??= class {
  load() {
    return Promise.reject(new Error('no fonts in tests'))
  }
}
globalThis.document ??= { fonts: { add() {} } }
