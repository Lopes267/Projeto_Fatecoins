// WebXR falso, injetado ANTES da página /captura (Page.addScriptToEvaluateOnNewDocument).
// Simula um Chrome de Android com ARCore: parede plana em z = -1 m no mundo,
// celular em pé na origem girando devagar, mapa de profundidade 160 x 90 deitado
// (mesmo giro do gerador sintético em Python) e centro óptico fora do meio.
//
// ?falso=sem-profundidade  -> requestSession recusa (aparelho sem Depth API)
// sempre: a 1ª tentativa com 'unsigned-short' recebe TypeError (Chrome antigo)
(function () {
  const modo = new URLSearchParams(location.search).get('falso') || 'parede';
  const LARG = 160, ALT = 90, NEAR = 0.05, FAR = 20;
  const tv = Math.tan((63 * Math.PI / 180) / 2);            // vertical 63°
  const ASPECTO = 9 / 16, DX = 0.02, DY = -0.015;
  const P00 = 1 / (tv * ASPECTO), P11 = 1 / tv;
  const linhas = (m) => { const c = new Float32Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) c[j * 4 + i] = m[i][j]; return c; };
  const P = linhas([[P00, 0, DX, 0], [0, P11, DY, 0],
    [0, 0, -(FAR + NEAR) / (FAR - NEAR), -2 * FAR * NEAR / (FAR - NEAR)], [0, 0, -1, 0]]);
  // u_mapa = v_vista ; v_mapa = 1 - u_vista
  const GIRO = [[0, 1, 0, 0], [-1, 0, 0, 1], [0, 0, 1, 0], [0, 0, 0, 1]];
  const M = linhas(GIRO);
  window.__xrPedidos = [];

  function pose(ms) {
    const yaw = 0.17 * Math.sin(ms / 1500), pitch = 0.05 * Math.sin(ms / 2100);
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // R = Ry(yaw) * Rx(pitch)
    const R = [[cy, sy * sp, sy * cp], [0, cp, -sp], [-sy, cy * sp, cy * cp]];
    const pos = [0.05 * Math.sin(ms / 1700), 0.02 * Math.sin(ms / 1300), 0];
    return { R, pos, matriz: linhas([[...R[0], pos[0]], [...R[1], pos[1]], [...R[2], pos[2]], [0, 0, 0, 1]]) };
  }

  function mapa({ R, pos }) {
    const buf = new Uint16Array(LARG * ALT);
    for (let r = 0; r < ALT; r++) {
      for (let c = 0; c < LARG; c++) {
        const du = (c + 0.5) / LARG, dv = (r + 0.5) / ALT;
        const u = 1 - dv, v = du;                              // inverso do GIRO
        const xn = 2 * u - 1, yn = 1 - 2 * v;
        const d = [(xn + DX) / P00, (yn + DY) / P11, -1];      // raio com Z = 1
        const dz = R[2][0] * d[0] + R[2][1] * d[1] + R[2][2] * d[2];
        const t = (-1 - pos[2]) / dz;                          // parede em z = -1
        buf[r * LARG + c] = t > 0 && t < 8 ? Math.round(t * 1000) : 0;
      }
    }
    return buf;
  }

  class QuadroFalso {
    constructor(ms) { this.p = pose(ms); }
    getViewerPose() {
      return { emulatedPosition: false,
               views: [{ projectionMatrix: P, transform: { matrix: this.p.matriz }, camera: undefined }] };
    }
    getDepthInformation() {
      const buf = mapa(this.p);
      return {
        width: LARG, height: ALT, data: buf.buffer, rawValueToMeters: 0.001,
        normDepthBufferFromNormView: { matrix: M },
        getDepthInMeters(x, y) {                               // algoritmo da especificação
          const du = GIRO[0][0] * x + GIRO[0][1] * y + GIRO[0][3];
          const dv = GIRO[1][0] * x + GIRO[1][1] * y + GIRO[1][3];
          const col = Math.floor(du * LARG), lin = Math.floor(dv * ALT);
          return buf[lin * LARG + col] * 0.001;
        }
      };
    }
  }

  class SessaoFalsa extends EventTarget {
    constructor() {
      super();
      this.renderState = { baseLayer: null };
      this.depthUsage = 'cpu-optimized';
      this.depthDataFormat = 'luminance-alpha';
      this.domOverlayState = { type: 'screen' };
      this.t0 = performance.now();
      this.ativa = true;
    }
    updateRenderState(s) { Object.assign(this.renderState, s); }
    async requestReferenceSpace(tipo) { return { tipo }; }
    requestAnimationFrame(cb) {
      if (!this.ativa) return 0;
      return setTimeout(() => { if (this.ativa) cb(performance.now(), new QuadroFalso(performance.now() - this.t0)); }, 16);
    }
    async end() { if (!this.ativa) return; this.ativa = false; this.dispatchEvent(new Event('end')); }
  }

  Object.defineProperty(navigator, 'xr', {
    configurable: true,
    value: {
      isSessionSupported: async (m) => m === 'immersive-ar',
      requestSession: async (m, opcoes) => {
        window.__xrPedidos.push(JSON.parse(JSON.stringify({ m, opcoes: { ...opcoes, domOverlay: !!opcoes.domOverlay } })));
        const formatos = (opcoes.depthSensing || {}).dataFormatPreference || [];
        if (formatos.includes('unsigned-short')) {
          throw new TypeError("The provided value 'unsigned-short' is not a valid enum value of type XRDepthDataFormat.");
        }
        if (modo === 'sem-profundidade') {
          throw new DOMException('The required feature depth-sensing is not supported', 'NotSupportedError');
        }
        return new SessaoFalsa();
      }
    }
  });
  window.XRWebGLLayer = class { constructor() { this.framebuffer = null; } };
  window.XRWebGLBinding = undefined;
})();
