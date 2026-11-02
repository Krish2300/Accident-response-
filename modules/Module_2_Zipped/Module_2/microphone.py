import sounddevice as sd
import wave


SAMPLE_RATE = 16000
CHANNELS = 1


def record_audio(filename="temp_audio.wav", duration=5):

    print("\nListening...")
    print("Speak now!")

    audio = sd.rec(
        int(duration * SAMPLE_RATE),
        samplerate=SAMPLE_RATE,
        channels=CHANNELS,
        dtype="int16"
    )

    sd.wait()

    print("Recording finished.")

    with wave.open(filename, "wb") as file:

        file.setnchannels(CHANNELS)
        file.setsampwidth(2)
        file.setframerate(SAMPLE_RATE)

        file.writeframes(audio.tobytes())

    print("Audio saved:", filename)


if __name__ == "__main__":
    record_audio()