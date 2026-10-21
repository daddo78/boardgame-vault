# Rulebook pages: a tiny service that turns a PDF page into an image and its text (see app.py)
FROM python:3.12.7-slim
RUN pip install --no-cache-dir pypdfium2==4.30.0 pillow==11.0.0
COPY app.py /app.py
RUN mkdir /work && chown nobody:nogroup /work
USER nobody
CMD ["python", "-u", "/app.py"]
