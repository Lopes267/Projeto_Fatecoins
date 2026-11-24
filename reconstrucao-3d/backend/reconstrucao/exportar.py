"""
Exportação: GLB (o que o site usa), OBJ e PLY.

O GLB é escrito à mão (sem biblioteca extra) para levar nos "extras" do nó
as mesmas marcas que o scanner antigo do site gravava: escaneado e
escalaReal. O ar-viewer.js lê escalaReal e mostra o modelo no tamanho
medido, em vez de esticá-lo até as medidas da embalagem.
"""
from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np
import open3d as o3d

FLOAT, UINT32 = 5126, 5125
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963


def _srgb_para_linear(c: np.ndarray) -> np.ndarray:
    # glTF guarda cor de vértice em espaço linear; a câmera entrega sRGB
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def glb_bytes(malha: o3d.geometry.TriangleMesh, extras: dict | None = None,
              nome: str = "produto-reconstruido") -> bytes:
    V = np.asarray(malha.vertices, dtype=np.float32)
    F = np.asarray(malha.triangles, dtype=np.uint32)
    if not len(V) or not len(F):
        raise ValueError("malha vazia")
    if not malha.has_vertex_normals():
        malha.compute_vertex_normals()
    N = np.asarray(malha.vertex_normals, dtype=np.float32)

    blob = bytearray()
    vistas, acessores = [], []

    def anexar(arr: np.ndarray, alvo: int, comp: int, tipo: str, limites=False) -> int:
        while len(blob) % 4:
            blob.append(0)
        dados = np.ascontiguousarray(arr).tobytes()
        vistas.append({"buffer": 0, "byteOffset": len(blob),
                       "byteLength": len(dados), "target": alvo})
        blob.extend(dados)
        ac = {"bufferView": len(vistas) - 1, "componentType": comp,
              "count": int(arr.shape[0]) if tipo != "SCALAR" else int(arr.size),
              "type": tipo}
        if limites:
            ac["min"] = [float(v) for v in arr.min(axis=0)]
            ac["max"] = [float(v) for v in arr.max(axis=0)]
        acessores.append(ac)
        return len(acessores) - 1

    atributos = {"POSITION": anexar(V, ARRAY_BUFFER, FLOAT, "VEC3", limites=True),
                 "NORMAL": anexar(N, ARRAY_BUFFER, FLOAT, "VEC3")}
    if malha.has_vertex_colors():
        C = _srgb_para_linear(np.clip(np.asarray(malha.vertex_colors), 0, 1)).astype(np.float32)
        atributos["COLOR_0"] = anexar(C, ARRAY_BUFFER, FLOAT, "VEC3")
    indices = anexar(F.reshape(-1), ELEMENT_ARRAY_BUFFER, UINT32, "SCALAR")

    gltf = {
        "asset": {"version": "2.0", "generator": "Mercado Local - reconstrucao-3d"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": nome, "extras": extras or {}}],
        "meshes": [{"name": nome, "primitives": [
            {"attributes": atributos, "indices": indices, "material": 0, "mode": 4}]}],
        # doubleSided: a base fica aberta (estava apoiada) e o lado de dentro aparece
        "materials": [{"name": "superficie", "doubleSided": True,
                       "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1],
                                                "metallicFactor": 0.0,
                                                "roughnessFactor": 0.85}}],
        "buffers": [{"byteLength": 0}],
        "bufferViews": vistas,
        "accessors": acessores,
    }
    while len(blob) % 4:
        blob.append(0)
    gltf["buffers"][0]["byteLength"] = len(blob)

    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    return (struct.pack("<4sII", b"glTF", 2, total)
            + struct.pack("<I4s", len(js), b"JSON") + js
            + struct.pack("<I4s", len(blob), b"BIN\x00") + bytes(blob))


def ler_glb(dados: bytes) -> tuple[dict, dict[str, np.ndarray]]:
    """Leitor mínimo (para os testes conferirem o arquivo que saiu)."""
    magia, versao, total = struct.unpack_from("<4sII", dados, 0)
    assert magia == b"glTF" and versao == 2 and total == len(dados), "cabeçalho GLB inválido"
    tam_js, tipo = struct.unpack_from("<I4s", dados, 12)
    assert tipo == b"JSON"
    gltf = json.loads(dados[20:20 + tam_js])
    pos = 20 + tam_js
    tam_bin, tipo = struct.unpack_from("<I4s", dados, pos)
    assert tipo == b"BIN\x00"
    binario = dados[pos + 8:pos + 8 + tam_bin]
    tipos = {FLOAT: np.float32, UINT32: np.uint32}
    larg = {"SCALAR": 1, "VEC3": 3}
    prim = gltf["meshes"][0]["primitives"][0]

    def acessor(i):
        ac = gltf["accessors"][i]
        bv = gltf["bufferViews"][ac["bufferView"]]
        arr = np.frombuffer(binario, dtype=tipos[ac["componentType"]],
                            count=ac["count"] * larg[ac["type"]], offset=bv["byteOffset"])
        return arr.reshape(ac["count"], larg[ac["type"]]) if ac["type"] != "SCALAR" else arr

    arrays = {k: acessor(v) for k, v in prim["attributes"].items()}
    arrays["indices"] = acessor(prim["indices"])
    return gltf, arrays


def salvar_tudo(pasta: Path, malha: o3d.geometry.TriangleMesh, extras: dict) -> dict:
    pasta.mkdir(parents=True, exist_ok=True)
    (pasta / "modelo.glb").write_bytes(glb_bytes(malha, extras))
    o3d.io.write_triangle_mesh(str(pasta / "modelo.ply"), malha)
    # OBJ não guarda normal de triângulo (o Open3D avisa a cada gravação)
    sem_normais_tri = o3d.geometry.TriangleMesh(malha)
    sem_normais_tri.triangle_normals = o3d.utility.Vector3dVector()
    o3d.io.write_triangle_mesh(str(pasta / "modelo.obj"), sem_normais_tri, write_triangle_uvs=False)
    return {ext: f"modelo.{ext}" for ext in ("glb", "obj", "ply")}
