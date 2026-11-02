from speech_to_text import SpeechToText


AUDIO_FILE = "test.wav"


def main():

    print("Starting speech recognition test...")

    stt = SpeechToText()

    result = stt.transcribe(AUDIO_FILE)

    print("\n======================================")
    print("Speech Recognition Result")
    print("======================================")

    print("Language   :", result["language"])
    print("Confidence :", round(result["confidence"], 2))
    print("Transcript :", result["transcript"])


if __name__ == "__main__":
    main()