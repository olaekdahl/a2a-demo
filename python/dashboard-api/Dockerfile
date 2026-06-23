FROM python:3.12-slim

WORKDIR /app

COPY python/dashboard-api/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY storage/schema.sql /app/schema.sql
COPY shared /app/shared
COPY python/dashboard-api/app /app/app
COPY python/dashboard-api/static /app/static

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
