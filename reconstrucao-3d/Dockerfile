# Serviço online da reconstrução 3D (Render, runtime Docker).
# Contexto do build = RAIZ do repositório (para levar junto o ar-viewer.js do site):
#   docker build -f reconstrucao-3d/Dockerfile .
FROM python:3.12-slim-bookworm

# Bibliotecas que o libOpen3D.so 0.20 pede ao sistema (lidas do DT_NEEDED da roda
# open3d-cpu para Linux). Sem elas o "import open3d" falha mesmo sem usar tela.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libgl1 libegl1 libx11-6 libidn2-0 libudev1 libusb-1.0-0 libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY reconstrucao-3d/requirements-servidor.txt .
RUN pip install --no-cache-dir -r requirements-servidor.txt \
 && python -c "import open3d, open3d.core; print('open3d', open3d.__version__)"

COPY reconstrucao-3d/backend ./backend
COPY reconstrucao-3d/web ./web
COPY ar-viewer.js ./site/ar-viewer.js

# Sessões em disco temporário: somem a cada novo deploy/reinício (é um teste)
ENV PYTHONUNBUFFERED=1 \
    SITE_DIR=/app/site \
    RECONSTRUCAO_SESSOES=/tmp/sessoes

# --proxy-headers: atrás do proxy do Render o esquema real é https (cookie Secure, wss)
CMD uvicorn backend.servidor:app --host 0.0.0.0 --port ${PORT:-8000} \
    --proxy-headers --forwarded-allow-ips="*" --ws-max-size 16777216
