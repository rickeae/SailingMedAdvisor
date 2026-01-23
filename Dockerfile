# Use a Python base image
FROM python:3.10-slim

# Set up a new user named "user" with user ID 1000
# Hugging Face requires a non-root user to run the container
RUN useradd -m -u 1000 user

# Set home and path for the new user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

# Set the working directory
WORKDIR $HOME/app

# Install bare essential system dependencies
# Removing software-properties-common to avoid the 'Unable to locate' error
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first to leverage Docker layer caching
COPY --chown=user requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir --upgrade -r requirements.txt

# Copy the rest of the application files
COPY --chown=user . .

# Switch to the non-root user for security
USER user

# Hugging Face Spaces listen on port 7860
EXPOSE 7860

# Create the uploads directory and ensure 'user' owns it
RUN mkdir -p /home/user/app/uploads && chown -R user:user /home/user/app/uploads

# Start the application
# Ensure 'app:app' matches your filename (app.py) and FastAPI instance name (app)
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860"]
