from microphone import record_audio
from speech_to_text import SpeechToText


AUDIO_FILE = "temp_audio.wav"


def main():

    print("======================================")
    print("   EMERGENCY SPEECH RECOGNITION")
    print("   English + Malayalam")
    print("======================================")

    # Load speech recognition model
    stt = SpeechToText()

    while True:

        print("\nPress ENTER to start recording.")
        print("Press Ctrl+C to stop the program.")

        input()

        # Record audio
        record_audio(
            filename=AUDIO_FILE,
            duration=5
        )

        # Convert speech to text
        result = stt.transcribe(AUDIO_FILE)

        print("\n--------------------------------------")
        print("Detected Language :", result["language"])
        print("Confidence        :", round(result["confidence"], 2))
        print("Transcript        :", result["transcript"])
        print("--------------------------------------")


if __name__ == "__main__":
    main()