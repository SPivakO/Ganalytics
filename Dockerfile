# Stage 1: Builder
FROM python:3.12-slim AS builder

WORKDIR /app

# Устанавливаем зависимости для сборки
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Создаем виртуальное окружение
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Очистка кэшей виртуального окружения
RUN find /opt/venv -type d -name "__pycache__" -exec rm -rf {} + && \
    find /opt/venv -type d -name "tests" -exec rm -rf {} +

# Stage 2: Runner
FROM python:3.12-slim

WORKDIR /app

# Копируем очищенное виртуальное окружение
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Настройки Python
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

# Копируем исходный код
COPY . .

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]