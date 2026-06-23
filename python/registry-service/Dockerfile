FROM python:3.12-slim

WORKDIR /app

COPY python/registry-service/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY storage/schema.sql /app/schema.sql
COPY python/registry-service/app /app/app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
