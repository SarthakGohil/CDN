# EdgeServer Dockerfile
FROM python:3.10-slim
WORKDIR /app
COPY . /app
RUN pip install flask requests
EXPOSE 3001
CMD ["python", "server.py"]