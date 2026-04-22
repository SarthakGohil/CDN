FROM python:3.11-slim
WORKDIR /app
COPY . /app

RUN pip install --no-cache-dir flask requests python-dotenv gunicorn

# HF Spaces requires port 7860
EXPOSE 7860

# Use gunicorn; threaded=True handled by --threads flag
CMD ["gunicorn", "--bind", "0.0.0.0:7860", "--workers", "2", "--threads", "4", "--timeout", "60", "server:app"]