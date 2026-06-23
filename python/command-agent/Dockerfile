FROM python:3.12-slim
WORKDIR /app
COPY python/command-agent/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY storage/schema.sql /app/schema.sql
COPY python/command-agent/app /app/app
EXPOSE 8001
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
