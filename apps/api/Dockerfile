FROM python:3.12-slim

# System deps kept minimal. Add build-essential / libpq-dev only if a wheel
# is missing — most modern wheels work out of the box on slim.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install python deps first (layer cache).
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# App code is bind-mounted in dev, but we COPY too so the image is runnable
# without compose for one-off tasks.
COPY . .

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
