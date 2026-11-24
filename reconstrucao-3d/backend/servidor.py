"""
Servidor da reconstrução 3D (FastAPI + WebSocket).

A estrutura — FastAPI, um gerente de conexões que difunde mensagens e
páginas estáticas com Three.js — vem do server.py do repositório
akshaybahadur21/Objectron (MIT). Lá a câmera é a webcam do próprio
computador; aqui os quadros chegam do celular.

Rotas:
  GET  /                       visualizador (computador)
  GET  /captura                página do celular (WebXR + profundidade)
  WS   /ws/captura             celular -> servidor (quadros binários)
  WS   /ws/visualizador        servidor -> computador (estado e malha)
  GET  /sessoes/<id>/<arq>     modelo.glb / .obj / .ply / sessao.json
  GET  /api/sessoes            sessões gravadas
  GET  /teste/ar-viewer        o .glb dentro do visualizador do site

Rodar:  .venv\\Scripts\\python -m backend.servidor   (de dentro de reconstrucao-3d)
Escuta só em 127.0.0.1: o celular chega pelo cabo (adb reverse tcp:8000 tcp:8000).

Online (Render, ver Dockerfile) só entra quem está logado no site: o botão
"Escanear com a câmera" do painel abre /entrar#token=<ID token do Firebase>,
o token é conferido com as chaves públicas do Google (backend/acesso.py) e
vira um cookie deste serviço. Quem só tem o endereço não vê a captura de
ninguém nem derruba o celular de quem está escaneando. CHAVE_ACESSO, se
definida, é uma segunda porta (chave digitada uma vez, cookie de 30 dias).
No computador (sem a variável RENDER) fica aberto, como antes.
"""
from __future__ import annotations

import asyncio
import html
import json
import os
import re
import secrets
import time
from pathlib import Path
from urllib.parse import urlencode

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .acesso import Cookies, TokenInvalido, VerificadorFirebase
from .reconstrucao.sessao import Sessao

RAIZ = Path(__file__).resolve().parents[1]
WEB = RAIZ / "web"
# No Docker o ar-viewer.js do site é copiado para SITE_DIR; no computador fica na pasta de cima
SITE = Path(os.environ.get("SITE_DIR") or RAIZ.parent)
ID_SESSAO = re.compile(r"^\d{8}-\d{6}(-\d+)?$")
ARQUIVOS = {"modelo.glb": "model/gltf-binary", "modelo.obj": "text/plain",
            "modelo.ply": "application/octet-stream", "sessao.json": "application/json"}
COOKIE_CHAVE = "rec3d_chave"
COOKIE_SESSAO = "rec3d_sessao"
# Não é segredo: vai dentro de todo token do site (campo aud)
PROJETO_FIREBASE = "fatecoin-mercado"
PUBLICOS = ("/saude", "/site/ar-viewer.js", "/entrar", "/api/entrar")   # e tudo em /web/

_ESTILO = """<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0;background:#0d0d0d;color:#f0ece3;font:16px/1.5 system-ui,sans-serif}
main{max-width:400px;margin:12vh auto;padding:0 16px}h1{font-size:20px}p{color:#a8a8a8}
input,button{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;font:inherit;margin-top:10px}
input{border:1px solid #2a2a2a;background:#1f1f1f;color:#f0ece3}
button{border:0;background:#e8854a;color:#1a0f08;font-weight:600}.erro{color:#e0605a}</style>"""

PAGINA_FORA = """<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Escaneamento 3D</title>
__ESTILO__</head><body><main><h1>Escaneamento 3D</h1>
<p>Este serviço abre pelo painel do Mercado Local: entre na sua loja, abra o cadastro
de um produto e toque em <b>Escanear com a câmera</b>.</p>__CHAVE__</main></body></html>"""

FORM_CHAVE = """<p>Ou use a chave de acesso:</p>__ERRO__<form method="get" action="__ACAO__">
<input name="chave" type="password" autocomplete="current-password" placeholder="Chave de acesso" required>
<button>Entrar</button></form>"""

PAGINA_ENTRAR = """<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Entrando…</title>
__ESTILO__</head><body><main><h1>Escaneamento 3D</h1><p id="msg">Entrando com o seu login do site…</p></main>
<script>
(async function () {
  var p = new URLSearchParams(location.hash.slice(1));
  var token = p.get('token'), ir = p.get('ir') || '/';
  if (!/^\\/(?!\\/)/.test(ir)) ir = '/';
  history.replaceState(null, '', location.pathname);          // o token sai do endereço
  var msg = document.getElementById('msg');
  if (!token) { location.replace(ir); return; }
  try {
    var r = await fetch('/api/entrar', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token }) });
    var d = await r.json();
    if (d.ok) { location.replace(ir); return; }
    msg.innerHTML = d.motivo === 'sessão do site expirada'
      ? 'Sua sessão no site expirou. Entre de novo no painel e toque no botão outra vez.'
      : 'Não deu para confirmar o seu login (' + d.motivo + '). Volte ao painel e tente de novo.';
    msg.className = 'erro';
  } catch (e) {
    msg.textContent = 'O serviço não respondeu. Se ele estava dormindo, espere 1 minuto e toque no botão de novo.';
    msg.className = 'erro';
  }
})();
</script></body></html>"""


class Gerente:
    """Quem está conectado e a sessão atual (inspirado no ConnectionManager do Objectron)."""

    def __init__(self, pasta_sessoes: Path):
        self.pasta_sessoes = pasta_sessoes
        self.visualizadores: set[WebSocket] = set()
        self.celular: WebSocket | None = None
        self.sessao: Sessao | None = None
        self.ultima_malha: bytes | None = None
        self.ultimo_estado: dict | None = None
        self.laco: asyncio.AbstractEventLoop | None = None
        self.intervalo_malha = 1.0

    async def _mandar(self, ws: WebSocket, dados):
        try:
            if isinstance(dados, (bytes, bytearray)):
                await ws.send_bytes(bytes(dados))
            else:
                await ws.send_text(json.dumps(dados, ensure_ascii=False))
        except Exception:
            self.visualizadores.discard(ws)

    async def difundir(self, dados, celular_tambem: bool = True):
        for ws in list(self.visualizadores):
            await self._mandar(ws, dados)
        if celular_tambem and self.celular is not None:
            await self._mandar(self.celular, dados)

    def aviso(self, tipo: str, dados):
        """Chamado da thread da sessão: agenda o envio no laço do servidor."""
        if tipo == "malha":
            self.ultima_malha = dados
        elif tipo == "estado":
            self.ultimo_estado = dados
        if self.laco is not None:
            # A malha só vai para o computador; o celular recebe estado e resultado
            asyncio.run_coroutine_threadsafe(
                self.difundir(dados, celular_tambem=(tipo != "malha")), self.laco)

    def nova_sessao(self, raio: float, modo: str) -> Sessao:
        base = time.strftime("%Y%m%d-%H%M%S")
        id_, n = base, 1
        while (self.pasta_sessoes / id_).exists():
            n += 1
            id_ = f"{base}-{n}"
        self.ultima_malha = None
        self.sessao = Sessao(id_, self.pasta_sessoes / id_, self.aviso, raio=raio, modo=modo,
                             intervalo_malha=self.intervalo_malha)
        return self.sessao


def criar_app(pasta_sessoes: Path | None = None, chave: str | None = None,
              exigir_login: bool | None = None, verificador=None) -> FastAPI:
    pasta = Path(pasta_sessoes or os.environ.get("RECONSTRUCAO_SESSOES") or RAIZ / "sessoes")
    pasta.mkdir(parents=True, exist_ok=True)
    chave = (chave if chave is not None else os.environ.get("CHAVE_ACESSO", "")).strip()
    if exigir_login is None:            # o Render define RENDER=true sozinho
        exigir_login = bool(os.environ.get("RENDER") or os.environ.get("EXIGIR_LOGIN"))
    protegido = exigir_login or bool(chave)
    verificador = verificador or VerificadorFirebase(
        os.environ.get("FIREBASE_PROJECT_ID") or PROJETO_FIREBASE)
    # Sem SEGREDO_SESSAO, um segredo por processo: reiniciar pede o botão de novo
    cookies = Cookies(os.environ.get("SEGREDO_SESSAO") or secrets.token_hex(32))
    g = Gerente(pasta)
    # No plano grátis do Render (0,1 CPU) extrair a prévia a cada segundo come a fusão
    g.intervalo_malha = float(os.environ.get("INTERVALO_MALHA", "1.0"))
    app = FastAPI(title="Reconstrução 3D — Mercado Local")
    app.state.gerente = g

    def confere_chave(valor: str | None) -> bool:
        return bool(chave) and bool(valor) and secrets.compare_digest(valor.encode(), chave.encode())

    def liberado(cookies_req, consulta) -> bool:
        return (not protegido
                or cookies.conferir(cookies_req.get(COOKIE_SESSAO)) is not None
                or confere_chave(cookies_req.get(COOKIE_CHAVE))
                or confere_chave(consulta.get("chave")))

    def pagina_fora(caminho: str, chave_errada: bool) -> HTMLResponse:
        form = ""
        if chave:
            form = (FORM_CHAVE.replace("__ERRO__", '<p class="erro">Chave errada.</p>' if chave_errada else "")
                    .replace("__ACAO__", html.escape(caminho)))
        return HTMLResponse(PAGINA_FORA.replace("__ESTILO__", _ESTILO).replace("__CHAVE__", form),
                            status_code=401)

    @app.middleware("http")
    async def porteiro(request: Request, call_next):
        # "//outro-site" viraria um redirecionamento para fora: fica "/outro-site"
        caminho = "/" + request.url.path.lstrip("/")
        if caminho in PUBLICOS or caminho.startswith("/web/"):
            return await call_next(request)
        if liberado(request.cookies, {}):
            return await call_next(request)
        dada = request.query_params.get("chave")
        if confere_chave(dada) and request.method == "GET":
            # Tira a chave do endereço (histórico, prints) e guarda no cookie
            resto = [(k, v) for k, v in request.query_params.multi_items() if k != "chave"]
            destino = caminho + ("?" + urlencode(resto) if resto else "")
            resp = RedirectResponse(destino, status_code=303)
            resp.set_cookie(COOKIE_CHAVE, chave, max_age=30 * 24 * 3600, httponly=True,
                            secure=request.url.scheme == "https", samesite="lax")
            return resp
        if caminho.startswith("/api/") or caminho.startswith("/sessoes/"):
            return JSONResponse({"erro": "entre pelo painel do site"}, status_code=401)
        return pagina_fora(caminho, chave_errada=bool(dada))

    def ws_liberado(ws: WebSocket) -> bool:
        return liberado(ws.cookies, ws.query_params)

    @app.get("/saude")
    async def saude():
        return {"ok": True}

    @app.get("/entrar")
    async def pagina_entrar():
        return HTMLResponse(PAGINA_ENTRAR.replace("__ESTILO__", _ESTILO),
                            headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})

    @app.post("/api/entrar")
    async def entrar(request: Request):
        try:
            corpo = await request.json()
            token = str(corpo.get("token", "")) if isinstance(corpo, dict) else ""
        except (json.JSONDecodeError, UnicodeDecodeError):
            return JSONResponse({"ok": False, "motivo": "pedido inválido"}, status_code=400)
        try:
            uid = await asyncio.to_thread(verificador.verificar, token)
        except TokenInvalido as e:
            return JSONResponse({"ok": False, "motivo": str(e)}, status_code=401)
        except Exception:          # chaves do Google fora do ar
            return JSONResponse({"ok": False, "motivo": "não deu para conferir com o Google"},
                                status_code=503)
        resp = JSONResponse({"ok": True})
        resp.set_cookie(COOKIE_SESSAO, cookies.emitir(uid), max_age=cookies.duracao, httponly=True,
                        secure=request.url.scheme == "https", samesite="lax")
        return resp

    @app.get("/")
    async def visualizador():
        return FileResponse(WEB / "visualizador.html")

    @app.get("/captura")
    async def captura():
        return FileResponse(WEB / "captura.html")

    @app.get("/teste/ar-viewer")
    async def teste_ar_viewer():
        return FileResponse(WEB / "teste-ar-viewer.html")

    @app.get("/site/ar-viewer.js")
    async def ar_viewer_do_site():
        # O mesmo arquivo que o cliente usa no site, para ver o modelo como ele veria
        return FileResponse(SITE / "ar-viewer.js", media_type="text/javascript")

    @app.get("/api/sessoes")
    async def listar():
        itens = []
        for p in sorted(pasta.iterdir(), reverse=True):
            meta = p / "sessao.json"
            if p.is_dir() and ID_SESSAO.match(p.name) and meta.exists():
                try:
                    itens.append(json.loads(meta.read_text(encoding="utf-8")))
                except json.JSONDecodeError:
                    pass
        return itens[:50]

    @app.get("/sessoes/{sessao_id}/{arquivo}")
    async def arquivo_da_sessao(sessao_id: str, arquivo: str):
        if not ID_SESSAO.match(sessao_id) or arquivo not in ARQUIVOS:
            raise HTTPException(404)
        caminho = pasta / sessao_id / arquivo
        if not caminho.is_file():
            raise HTTPException(404)
        return FileResponse(caminho, media_type=ARQUIVOS[arquivo],
                            filename=f"{sessao_id}-{arquivo}" if arquivo != "sessao.json" else None)

    @app.websocket("/ws/visualizador")
    async def ws_visualizador(ws: WebSocket):
        if not ws_liberado(ws):
            await ws.close(code=1008)        # antes do accept: o aperto de mão é recusado
            return
        await ws.accept()
        g.visualizadores.add(ws)
        await g._mandar(ws, {"tipo": "ola", "celular": g.celular is not None,
                             "sessao": g.sessao.id if g.sessao else None})
        if g.ultimo_estado:
            await g._mandar(ws, g.ultimo_estado)
        if g.ultima_malha:
            await g._mandar(ws, g.ultima_malha)
        if g.sessao and g.sessao.resultado:
            await g._mandar(ws, g.sessao.resultado)
        try:
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            g.visualizadores.discard(ws)

    @app.websocket("/ws/captura")
    async def ws_captura(ws: WebSocket):
        g.laco = asyncio.get_running_loop()      # a thread da sessão agenda envios nele
        if not ws_liberado(ws):
            await ws.close(code=1008)
            return
        await ws.accept()
        if g.celular is not None:          # só um celular por vez: o novo assume
            try:
                await g.celular.close(code=4000, reason="outro aparelho assumiu")
            except Exception:
                pass
        g.celular = ws
        await g.difundir({"tipo": "celular", "conectado": True}, celular_tambem=False)
        sessao: Sessao | None = None
        try:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if msg.get("bytes") is not None:
                    if sessao is None:
                        await g._mandar(ws, {"tipo": "erro", "mensagem": "mande 'iniciar' antes dos quadros"})
                    else:
                        sessao.receber(msg["bytes"])
                    continue
                try:
                    cmd = json.loads(msg.get("text") or "{}")
                except json.JSONDecodeError:
                    continue
                if cmd.get("tipo") == "iniciar":
                    if sessao is not None and sessao.resultado is None:
                        await asyncio.to_thread(sessao.finalizar)
                    try:
                        raio = min(0.6, max(0.08, float(cmd.get("raio", 0.25))))
                    except (TypeError, ValueError):
                        raio = 0.25
                    modo = "todos" if cmd.get("modo") == "todos" else "tempo-real"
                    sessao = g.nova_sessao(raio, modo)
                    await g._mandar(ws, {"tipo": "sessao", "id": sessao.id, "raio": raio, "modo": modo})
                    await g.difundir({"tipo": "nova-sessao", "id": sessao.id}, celular_tambem=False)
                elif cmd.get("tipo") == "finalizar" and sessao is not None:
                    await asyncio.to_thread(sessao.finalizar)   # o resultado sai pelo aviso()
                    sessao = None
        except WebSocketDisconnect:
            pass
        finally:
            if g.celular is ws:
                g.celular = None
            await g.difundir({"tipo": "celular", "conectado": False}, celular_tambem=False)
            # Celular caiu no meio: fecha o que já foi capturado em vez de perder
            if sessao is not None and sessao.resultado is None:
                await asyncio.to_thread(sessao.finalizar)

    app.mount("/web", StaticFiles(directory=WEB), name="web")
    return app


app = criar_app()

if __name__ == "__main__":
    import uvicorn
    porta = int(os.environ.get("PORTA", "8000"))
    print(f"\nReconstrução 3D em http://localhost:{porta}  (celular: adb reverse tcp:{porta} tcp:{porta})\n")
    uvicorn.run(app, host="127.0.0.1", port=porta, ws_max_size=16 * 1024 * 1024)
