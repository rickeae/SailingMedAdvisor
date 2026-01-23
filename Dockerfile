# Use a Python base image with CUDA support for MedGemma
FROM python:3.10-slim

# Set up a new user named "user" with user ID 1000
RUN useradd -m -u 1000 user

# Set home and path for the new user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

# Set the working directory
WORKDIR $HOME/app

# Install system dependencies (needed for some medical/image libraries)
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    software-properties-common \
    && rm -rf /var/lib/apt/apt/lists/*

# Copy requirements and install them
COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --upgrade -r requirements.txt

# Copy the rest of the application
COPY --chown=user . .

# Switch to the non-root user
USER user

# Tell Hugging Face to listen on port 7860
EXPOSE 7860

# Start the application using uvicorn
# We use app:app because your file is named app.py
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
