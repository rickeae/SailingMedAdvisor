#!/bin/bash
# run_med_advisor.sh - Secure startup script for MedGemma Advisor

echo "=================================================="
echo "🏥 Starting MedGemma Offshore Medical Advisor..."
echo "=================================================="

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "❌ Error: Virtual environment not found!"
    echo "Please create it first: python3 -m venv venv"
    exit 1
fi

# Activate virtual environment
source venv/bin/activate

# Check if required packages are installed
python3 -c "import flask" 2>/dev/null || {
    echo "❌ Error: Flask not installed. Run: pip install -r requirements.txt"
    exit 1
}

# Set environment variables (optional - can be customized)
# export ADMIN_PASSWORD='your_secure_password'
# export SECRET_KEY='your_secret_key'

# Run the application
echo "🚀 Starting server on http://127.0.0.1:5000"
echo "=================================================="
python3 app.py
