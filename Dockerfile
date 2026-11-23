FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN grep -v pywebview requirements.txt > req.txt && pip install --no-cache-dir -r req.txt
COPY . .
ENV CC_PUBLIC_DEMO=1 PYTHONUNBUFFERED=1
EXPOSE 8765
CMD ["python", "run.py", "--no-window"]
