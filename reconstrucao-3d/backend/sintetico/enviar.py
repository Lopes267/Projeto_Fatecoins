"""
Demonstração sem celular: manda a captura sintética da caneca para o
servidor, como a página do celular faria, num ritmo parecido com o real.
Com o visualizador aberto (http://localhost:8000) dá para ver a malha crescer.

    .venv\\Scripts\\python -m backend.sintetico.enviar [ws://127.0.0.1:8000] [--rapido] [--limpo]
    .venv\\Scripts\\python -m backend.sintetico.enviar wss://<servico>.onrender.com --chave <CHAVE_ACESSO>

Imprime o resultado (JSON) no fim.
"""
from __future__ import annotations

import json
import sys
import time
from urllib.parse import quote

from websockets.sync.client import connect

from . import gerar


def main(argv):
    url = next((a for a in argv if a.startswith("ws")), "ws://127.0.0.1:8000")
    rapido = "--rapido" in argv
    chave = argv[argv.index("--chave") + 1] if "--chave" in argv else None
    destino = url.rstrip("/") + "/ws/captura" + (f"?chave={quote(chave)}" if chave else "")
    with connect(destino, max_size=None, open_timeout=90) as ws:   # o plano grátis demora a acordar
        ws.send(json.dumps({"tipo": "iniciar", "modo": "todos", "raio": 0.25}))
        print(json.loads(ws.recv(10)), file=sys.stderr)
        for i, msg in enumerate(gerar.quadros(n=90, ruido="--limpo" not in argv, seed=3)):
            ws.send(msg)
            if not rapido:
                time.sleep(0.12)
        ws.send(json.dumps({"tipo": "finalizar"}))
        while True:
            dados = json.loads(ws.recv(180))
            if dados.get("tipo") == "pronto":
                print(json.dumps(dados, ensure_ascii=False))
                return 0 if dados.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
