# Training container for <1B full fine-tunes on RunPod.
# Base: PyTorch + CUDA runtime. Slim enough to pull fast, has CUDA for GPU training.
FROM pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime

ENV PYTHONUNBUFFERED=1 \
    HF_HUB_ENABLE_HF_TRANSFER=1 \
    TOKENIZERS_PARALLELISM=false

WORKDIR /app

# Install training deps. Pinned-ish for reproducibility; bump deliberately.
RUN pip install --no-cache-dir \
    "transformers>=4.44,<5" \
    "datasets>=2.20" \
    "accelerate>=0.33" \
    "peft>=0.12" \
    "trl>=0.9,<0.11" \
    "bitsandbytes>=0.43" \
    "evaluate>=0.4" \
    "huggingface_hub>=0.24" \
    "hf_transfer>=0.1.6" \
    "scikit-learn>=1.3" \
    "sentencepiece>=0.2"

COPY train.py /app/train.py

# The pod runs this. All config comes from env vars (see train.py header).
ENTRYPOINT ["python", "/app/train.py"]
