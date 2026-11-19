FROM python:3.12-slim
WORKDIR /app
COPY deals.py portals.py worker.py ./
USER 1000:1000
CMD ["python", "-u", "worker.py"]
