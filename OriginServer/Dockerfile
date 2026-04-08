# OriginServer Dockerfile
FROM python:3.10-slim
WORKDIR /app
COPY . /app
RUN pip install flask requests
EXPOSE 5000
CMD ["python", "server.py"]