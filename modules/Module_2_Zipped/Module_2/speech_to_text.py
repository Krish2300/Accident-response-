from faster_whisper import WhisperModel


class SpeechToText:

    def __init__(self):

        print("Loading speech recognition model...")
        print("Please wait. The first time may take a few minutes.")

        self.model = WhisperModel(
            "base",
            device="cpu",
            compute_type="int8"
        )

        print("Model loaded successfully!")

    def transcribe(self, audio_file):

        print("\nTranscribing audio...")

        try:

            segments, info = self.model.transcribe(
                audio_file,
                beam_size=5,
                vad_filter=True
            )

            transcript = ""

            for segment in segments:
                transcript += segment.text + " "

            transcript = transcript.strip()

            result = {
                "language": info.language,
                "confidence": info.language_probability,
                "transcript": transcript
            }

            print("\nDetected language:", info.language)
            print(
                "Language confidence:",
                round(info.language_probability, 2)
            )

            print("Transcript:", transcript)

            return result

        except Exception as e:

            print("Error during transcription:", e)

            return {
                "language": None,
                "confidence": 0,
                "transcript": ""
            }


if __name__ == "__main__":

    print("Speech-to-Text module is starting...")

    stt = SpeechToText()

    print("Speech-to-Text module is ready!")

    print()
    print("Testing with temp_audio.wav...")

    result = stt.transcribe("temp_audio.wav")

    print()
    print("Final result:")
    print(result)