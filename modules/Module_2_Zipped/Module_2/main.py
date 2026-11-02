from microphone import record_audio
from speech_to_text import SpeechToText


def main():

    print("=" * 50)
    print("EMERGENCY RESPONSE - SPEECH PROCESSING")
    print("=" * 50)

    # Step 1: Record audio
    record_audio(
        filename="temp_audio.wav",
        duration=7
    )

    # Step 2: Load speech recognition model
    stt = SpeechToText()

    # Step 3: Convert speech to text
    result = stt.transcribe(
        "temp_audio.wav"
    )

    # Step 4: Display result
    print()
    print("=" * 50)
    print("SPEECH RECOGNITION RESULT")
    print("=" * 50)

    print("Language:", result["language"])
    print("Confidence:", result["confidence"])
    print("Transcript:", result["transcript"])

    print("=" * 50)


if __name__ == "__main__":
    main()