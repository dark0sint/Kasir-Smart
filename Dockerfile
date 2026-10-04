FROM python:3.12-slim
WORKDIR /app
COPY server.py ./
COPY static ./static
ENV KASIR_HOST=0.0.0.0 KASIR_PORT=8080 KASIR_DB=/data/kasir.db KASIR_TZ=7
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/api/health')" || exit 1
CMD ["python", "server.py"]
