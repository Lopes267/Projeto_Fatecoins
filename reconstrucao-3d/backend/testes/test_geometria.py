"""Convenções: projeção, grade da profundidade, eixos, espelhamento e GLB."""
import math

import numpy as np
import open3d as o3d
import pytest

from backend.reconstrucao import exportar
from backend.reconstrucao import geometria as geo
from backend.reconstrucao import quadro
from backend.sintetico import gerar
from backend.sintetico.motor import Camera, Projection, renderizar


def _projecao(h_fov=math.radians(40), aspecto=9 / 16, dx=0.02, dy=-0.015, n=0.05, f=20.0):
    t = math.tan(h_fov / 2)
    return np.array([[1 / t, 0, dx, 0], [0, aspecto / t, dy, 0],
                     [0, 0, -(f + n) / (f - n), -2 * f * n / (f - n)], [0, 0, -1, 0]])


def test_matriz_de_colunas_ida_e_volta():
    M = np.arange(16, dtype=float).reshape(4, 4)
    assert np.allclose(geo.matriz_de_colunas(geo.para_colunas(M)), M)
    with pytest.raises(ValueError):
        geo.matriz_de_colunas([1, 2, 3])
    with pytest.raises(ValueError):
        geo.matriz_de_colunas([float("nan")] * 16)


def test_intrinsecos_batem_com_a_projecao_do_opengl():
    """Projetar com P e voltar com (fx, fy, cx, cy) devolve o mesmo ponto."""
    P = _projecao()
    larg, alt = 90, 160
    fx, fy, cx, cy = geo.intrinsecos_da_projecao(P, larg, alt)
    p_gl = np.array([0.03, -0.05, -0.6, 1.0])              # à frente (z negativo)
    clip = P @ p_gl
    ndc = clip[:3] / clip[3]
    u = (ndc[0] + 1) / 2 * larg - 0.5                       # índice de pixel (Open3D)
    v = (1 - ndc[1]) / 2 * alt - 0.5
    Z = 0.6
    X, Y = (u - cx) * Z / fx, (v - cy) * Z / fy             # fórmula da seção 6
    assert np.allclose([X, Y, Z], [p_gl[0], -p_gl[1], -p_gl[2]], atol=1e-9)


def test_grade_da_vista_tem_o_formato_da_vista():
    P = _projecao(aspecto=9 / 16)
    larg, alt = geo.grade_da_vista(P, 160, 90)
    assert (larg, alt) == (90, 160)


def test_amostragem_segue_a_matriz_de_giro():
    """Mapa deitado 4x2 + giro de 90°: cada pixel da vista lê o pixel certo do mapa."""
    mapa = np.arange(8, dtype=float).reshape(2, 4)          # 2 linhas, 4 colunas
    vista = geo.amostrar_na_vista(mapa, gerar.GIRO, 2, 4)   # vista 2 x 4 (em pé)
    # u_mapa = v_vista ; v_mapa = 1 - u_vista
    for lin in range(4):
        for col in range(2):
            u, v = (col + 0.5) / 2, (lin + 0.5) / 4
            esperado = mapa[int((1 - u) * 2), int(v * 4)]
            assert vista[lin, col] == esperado
    assert geo.amostrar_ponto(mapa, gerar.GIRO, 0.25, 0.125) == vista[0, 0]


def test_pose_cv_poe_o_que_esta_a_frente_em_z_positivo():
    T = np.eye(4)
    T[:3, 3] = [1, 2, 3]
    E = geo.extrinseca(T)
    frente_no_mundo = np.array([1, 2, 3 - 0.5, 1])          # câmera GL olha para -z
    p = E @ frente_no_mundo
    assert np.allclose(p[:3], [0, 0, 0.5])
    cima_no_mundo = np.array([1, 2.1, 3, 1])
    assert (E @ cima_no_mundo)[1] < 0                        # OpenCV: y para baixo


def test_motor_corrigido_nao_espelha():
    """
    Câmera em z = -1 olhando para +z, y para cima. Numa câmera de verdade a
    direita da imagem é -x. O motor original (right = +x fixo) punha +x à
    direita: imagem espelhada.
    """
    cam = Camera(64, 64, (0, 0, -1), h_fov=math.radians(60))
    cam.olhar_para((0, 0, 0))
    assert np.allclose(cam.right[:3], [-1, 0, 0])
    proj = Projection(cam)
    tri = np.array([[-0.3, -0.05, 0], [-0.2, -0.05, 0], [-0.25, 0.05, 0]])   # em x negativo
    zbuf, _ = renderizar(tri, np.array([[0, 1, 2]]), cam, proj)
    cols = np.nonzero(zbuf.max(0) > 0)[0]
    assert cols.min() > 32, "o triângulo em -x tem de aparecer na metade DIREITA"
    assert np.allclose(zbuf[zbuf > 0], 1.0, atol=1e-6)      # profundidade z exata


def test_motor_campo_de_visao_vertical_exato():
    cam = Camera(160, 90, (0, 0, 0), h_fov=math.radians(60))
    esperado = 2 * math.atan(math.tan(math.radians(30)) * 90 / 160)
    assert abs(cam.v_fov - esperado) < 1e-12
    assert abs(math.degrees(math.radians(60) * 90 / 160) - 33.75) < 1e-9   # o do original


def test_projecao_do_motor_e_a_do_webxr_coincidem():
    cam = Camera(90, 160, (0.1, 0.2, 0.5), h_fov=math.radians(38))
    cam.olhar_para((0, 0, 0))
    proj = Projection(cam, 0.02, -0.015)
    p_mundo = np.array([0.02, 0.03, -0.01])
    tela, _ = __import__("backend.sintetico.motor", fromlist=["projetar"]).projetar(
        np.array([[*p_mundo, 1.0]]), cam, proj)
    # o mesmo ponto pelo caminho do servidor: pose GL -> extrínseca -> intrínsecos
    fx, fy, cx, cy = geo.intrinsecos_da_projecao(proj.projecao_gl(), 90, 160)
    pc = geo.extrinseca(cam.transformacao_gl()) @ np.array([*p_mundo, 1.0])
    u = fx * pc[0] / pc[2] + cx + 0.5                       # +0,5: pixel contínuo
    v = fy * pc[1] / pc[2] + cy + 0.5
    assert np.allclose(tela[0], [u, v], atol=1e-9)


def test_quadro_ida_e_volta_e_recusas():
    msg = next(gerar.quadros(n=4, ruido=False))
    q = quadro.ler(msg)
    assert q.profundidade.shape == (90, 160) and q.cor.shape == (320, 180, 3)
    assert 0.2 < np.median(q.profundidade[q.profundidade > 0]) < 1.0
    with pytest.raises(quadro.QuadroInvalido):
        quadro.ler(msg[:200])                                   # cortado
    with pytest.raises(quadro.QuadroInvalido):
        quadro.ler(b"\x05\x00\x00\x00{}xxx")
    with pytest.raises(quadro.QuadroInvalido):
        quadro.ler(quadro.montar({"tipo": "quadro", "vista": {}, "profundidade": {}}, b""))
    import json
    import struct
    tam = struct.unpack_from("<I", msg)[0]
    cab = json.loads(msg[4:4 + tam])
    cab["profundidade"]["largura"] = 100000                     # tamanho absurdo
    with pytest.raises(quadro.QuadroInvalido):
        quadro.ler(quadro.montar(cab, msg[4 + tam:4 + tam + 160 * 90 * 2]))


def test_glb_ida_e_volta_com_extras():
    m = o3d.geometry.TriangleMesh.create_box(0.08, 0.095, 0.08)
    m.paint_uniform_color([0.8, 0.2, 0.1])
    m.compute_vertex_normals()
    dados = exportar.glb_bytes(m, {"escalaReal": True, "alturaCm": 9.5})
    assert len(dados) % 4 == 0
    gltf, arr = exportar.ler_glb(dados)
    assert gltf["nodes"][0]["extras"] == {"escalaReal": True, "alturaCm": 9.5}
    assert np.allclose(arr["POSITION"], np.asarray(m.vertices), atol=1e-6)
    assert np.array_equal(arr["indices"].reshape(-1, 3), np.asarray(m.triangles))
    assert arr["COLOR_0"].max() < 0.8          # sRGB 0,8 -> linear ~0,6
    ac = gltf["accessors"][gltf["meshes"][0]["primitives"][0]["attributes"]["POSITION"]]
    assert np.allclose(ac["max"], [0.08, 0.095, 0.08], atol=1e-6)
