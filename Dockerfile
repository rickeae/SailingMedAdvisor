FROM python:3.10-slim

# 1. Install system tools as ROOT
RUN apt-get update && apt-get install -y build-essential curl && rm -rf /var/lib/apt/lists/*

# 2. Setup the user but STAY as root for a moment
RUN useradd -m -u 1000 user
WORKDIR /home/user/app

# 3. Create the folder while still ROOT
RUN mkdir -p /home/user/app/uploads && chown -R user:user /home/user/app/uploads

# 4. NOW switch to the user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

# 5. Copy files and install (using --chown for safety)
COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --upgrade -r requirements.txt
COPY --chown=user . .

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
