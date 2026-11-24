"""
Reprocessa uma captura gravada (etapa 5 do plano): lê sessoes/<id>/quadros/*.bin
e refaz a reconstrução, com outros parâmetros se quiser. Nada é descartado.

    .venv\\Scripts\\python -m backend.reprocessar sessoes\\<id> [--voxel 0.003] [--trunc 3] [--raio 0.25]

Grava em sessoes/<id>/reprocessado/ (modelo.glb/.obj/.ply) e imprime o resumo.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from .reconstrucao import exportar
from .reconstrucao.quadro import QuadroInvalido, ler
from .reconstrucao.tsdf import Reconstrutor


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pasta", type=Path)
    ap.add_argument("--voxel", type=float, default=0.003)
    ap.add_argument("--trunc", type=float, default=3.0, help="truncamento em voxels")
    ap.add_argument("--raio", type=float, default=None, help="padrão: o da sessão")
    ap.add_argument("--peso", type=float, default=3.0, help="peso mínimo na extração")
    a = ap.parse_args()

    meta = {}
    if (a.pasta / "sessao.json").exists():
        meta = json.loads((a.pasta / "sessao.json").read_text(encoding="utf-8"))
    raio = a.raio or meta.get("raio", 0.25)
    rec = Reconstrutor(voxel=a.voxel, trunc_voxels=a.trunc, raio=raio)
    arquivos = sorted((a.pasta / "quadros").glob("*.bin"))
    t0 = time.perf_counter()
    invalidos = 0
    for f in arquivos:
        try:
            rec.integrar(ler(f.read_bytes()))
        except QuadroInvalido:
            invalidos += 1
    malha, info = rec.malha_final(peso_min=a.peso)
    resumo = {"quadros": len(arquivos), "integrados": rec.integrados, "invalidos": invalidos,
              "recusados": rec.recusados, "sondas": rec.sondas,
              "segundos": round(time.perf_counter() - t0, 1),
              **{k: v for k, v in info.items() if k != "mundo_do_modelo"}}
    if len(malha.triangles):
        m = info["medidas_cm"]
        exportar.salvar_tudo(a.pasta / "reprocessado", malha, {
            "escaneado": True, "escalaReal": True, "origem": "reconstrucao-3d (TSDF, reprocessado)",
            "larguraCm": m["largura"], "alturaCm": m["altura"], "profundidadeCm": m["profundidade"],
            "mundoDoModelo": [float(v) for v in info["mundo_do_modelo"].T.reshape(16)]})
        resumo["saida"] = str(a.pasta / "reprocessado")
    print(json.dumps(resumo, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
