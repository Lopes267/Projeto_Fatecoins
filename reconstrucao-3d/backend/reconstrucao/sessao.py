"""
Uma sessão de captura: recebe quadros, integra numa thread à parte e avisa
quem estiver olhando (celular e visualizador do computador).

Controle de fila (seção 7 da especificação): no modo "tempo-real" só o
quadro mais novo espera a vez; se a fusão atrasar, os antigos são
descartados e a latência não cresce. No modo "todos" (testes e
reprocessamento) nenhum quadro é descartado.

Todo quadro recebido é gravado cru em sessoes/<id>/quadros/, para dar para
reprocessar a captura depois (etapa 5 do plano).
"""
from __future__ import annotations

import collections
import json
import struct
import threading
import time
from pathlib import Path
from typing import Callable

import numpy as np
import open3d as o3d

from . import exportar
from .quadro import QuadroInvalido, ler
from .tsdf import Reconstrutor


def pacote_malha(malha: o3d.geometry.TriangleMesh, extra: dict) -> bytes:
    """
    Malha para o visualizador, em binário (JSON com listas ficaria 10x maior):
      [uint32 tamanho do cabeçalho][cabeçalho JSON, completado até múltiplo de 4]
      [float32 vértices nv*3][uint32 faces nf*3][uint8 cores nv*3]
    """
    V = np.asarray(malha.vertices, np.float32)
    F = np.asarray(malha.triangles, np.uint32)
    C = (np.clip(np.asarray(malha.vertex_colors), 0, 1) * 255).astype(np.uint8) \
        if malha.has_vertex_colors() else np.full((len(V), 3), 180, np.uint8)
    cab = json.dumps({"tipo": "malha", "nv": len(V), "nf": len(F), **extra},
                     separators=(",", ":")).encode("utf-8")
    cab += b" " * ((4 - (4 + len(cab)) % 4) % 4)
    return struct.pack("<I", len(cab)) + cab + V.tobytes() + F.tobytes() + C.tobytes()


class Sessao:
    def __init__(self, id: str, pasta: Path, aviso: Callable[[str, object], None],
                 raio: float = 0.25, modo: str = "tempo-real", voxel: float = 0.003,
                 intervalo_malha: float = 1.0, gravar_quadros: bool = True):
        self.id = id
        self.pasta = pasta
        self.aviso = aviso
        self.modo = modo
        self.intervalo_malha = intervalo_malha
        self.gravar_quadros = gravar_quadros
        self.rec = Reconstrutor(voxel=voxel, raio=raio)
        self.recebidos = self.descartados = self.invalidos = 0
        self.ultimo_erro: str | None = None
        self.latencias: collections.deque = collections.deque(maxlen=60)
        self.tempo_integracao: collections.deque = collections.deque(maxlen=60)
        self.triangulos = 0
        self.resultado: dict | None = None
        self._fila: collections.deque = collections.deque()
        self._cond = threading.Condition()
        self._fim = False
        self._inicio = time.perf_counter()
        (pasta / "quadros").mkdir(parents=True, exist_ok=True)
        (pasta / "sessao.json").write_text(json.dumps(
            {"id": id, "raio": raio, "modo": modo, "voxel": voxel,
             "inicio": time.strftime("%Y-%m-%d %H:%M:%S")}, indent=2), encoding="utf-8")
        self._thread = threading.Thread(target=self._trabalhar, name=f"sessao-{id}", daemon=True)
        self._thread.start()

    # ---------- chamado pelo servidor (laço do asyncio) ----------

    def receber(self, mensagem: bytes):
        self.recebidos += 1
        if self.gravar_quadros:
            (self.pasta / "quadros" / f"{self.recebidos:05d}.bin").write_bytes(mensagem)
        with self._cond:
            if self.modo == "tempo-real" and self._fila:
                self._fila.popleft()
                self.descartados += 1
            self._fila.append((time.perf_counter(), mensagem))
            self._cond.notify()

    def finalizar(self, espera: float = 120.0) -> dict:
        """Bloqueia até o modelo final ficar pronto (chamar via to_thread)."""
        with self._cond:
            self._fim = True
            self._cond.notify()
        self._thread.join(espera)
        return self.resultado or {"ok": False, "motivo": "a reconstrução não terminou a tempo"}

    def estado(self) -> dict:
        lat = list(self.latencias)
        integ = list(self.tempo_integracao)
        return {"tipo": "estado", "sessao": self.id,
                "recebidos": self.recebidos, "integrados": self.rec.integrados,
                "descartados": self.descartados, "invalidos": self.invalidos,
                "recusados": dict(self.rec.recusados), "ultimo_erro": self.ultimo_erro,
                "latencia_ms": round(1000 * float(np.mean(lat)), 1) if lat else None,
                "integracao_ms": round(1000 * float(np.mean(integ)), 1) if integ else None,
                "triangulos": self.triangulos, "sondas": dict(self.rec.sondas),
                "alvo": None if self.rec.centro is None else [round(float(v), 4) for v in self.rec.centro],
                "segundos": round(time.perf_counter() - self._inicio, 1)}

    # ---------- thread de trabalho ----------

    def _publicar_malha(self):
        malha = self.rec.malha_bruta(peso_min=2.0)
        self.triangulos = len(malha.triangles)
        if self.triangulos:
            self.aviso("malha", pacote_malha(malha, {
                "cameras": self.rec.cameras[-400:],
                "alvo": None if self.rec.centro is None else self.rec.centro.tolist(),
                "raio": self.rec.raio}))

    def _trabalhar(self):
        ultimo_malha = ultimo_estado = 0.0
        while True:
            with self._cond:
                while not self._fila and not self._fim:
                    self._cond.wait(0.5)
                if self._fila:
                    chegada, mensagem = self._fila.popleft()
                else:
                    break                       # fim pedido e fila vazia
            t0 = time.perf_counter()
            try:
                self.rec.integrar(ler(mensagem))
            except QuadroInvalido as e:
                self.invalidos += 1
                self.ultimo_erro = str(e)
            except Exception as e:      # um quadro estranho não pode matar a sessão
                self.invalidos += 1
                self.ultimo_erro = f"{type(e).__name__}: {e}"
            agora = time.perf_counter()
            self.tempo_integracao.append(agora - t0)
            self.latencias.append(agora - chegada)
            if agora - ultimo_malha >= self.intervalo_malha:
                self._publicar_malha()
                ultimo_malha = time.perf_counter()
            if agora - ultimo_estado >= 0.25:
                self.aviso("estado", self.estado())
                ultimo_estado = agora
        self.aviso("estado", self.estado())
        try:
            self.resultado = self._concluir()
        except Exception as e:      # o celular precisa de uma resposta mesmo assim
            self.resultado = {"tipo": "pronto", "ok": False,
                              "motivo": f"erro ao montar o modelo: {type(e).__name__}: {e}",
                              "estado": self.estado()}
        finally:
            self.rec.liberar()
        self.aviso("pronto", self.resultado)

    def _concluir(self) -> dict:
        t0 = time.perf_counter()
        bruta = self.rec.malha_bruta(peso_min=3.0)
        if len(bruta.triangles):
            o3d.io.write_triangle_mesh(str(self.pasta / "bruta-mundo.ply"), bruta)
        malha, info = self.rec.malha_final(peso_min=3.0)
        estado = self.estado()
        if len(malha.triangles) == 0:
            motivo = ("nenhum quadro foi integrado" if self.rec.integrados == 0
                      else "o volume não formou superfície do objeto")
            res = {"tipo": "pronto", "ok": False, "motivo": motivo, "estado": estado}
        else:
            extras = {"escaneado": True, "escalaReal": True,
                      "origem": "reconstrucao-3d (TSDF)",
                      "larguraCm": info["medidas_cm"]["largura"],
                      "alturaCm": info["medidas_cm"]["altura"],
                      "profundidadeCm": info["medidas_cm"]["profundidade"],
                      "quadros": self.rec.integrados,
                      "mundoDoModelo": [float(v) for v in info["mundo_do_modelo"].T.reshape(16)]}
            arquivos = exportar.salvar_tudo(self.pasta, malha, extras)
            res = {"tipo": "pronto", "ok": True, "sessao": self.id,
                   "arquivos": {k: f"/sessoes/{self.id}/{v}" for k, v in arquivos.items()},
                   "medidas_cm": info["medidas_cm"], "plano_de_apoio": info["plano"],
                   "triangulos": info["triangulos"], "pedacos": info.get("pedacos"),
                   "segundos_final": round(time.perf_counter() - t0, 2), "estado": estado}
        meta = json.loads((self.pasta / "sessao.json").read_text(encoding="utf-8"))
        meta["resultado"] = res
        (self.pasta / "sessao.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False),
                                                encoding="utf-8")
        return res
