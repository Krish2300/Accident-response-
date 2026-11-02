class AnswerProcessor:

    def process_yes_no(self, answer):
        """
        Converts natural language yes/no answers
        into True or False.
        """

        answer = answer.strip().lower()

        # Clear YES answers
        yes_words = [
            "yes",
            "yeah",
            "yep",
            "y",
            "true",
            "correct"
        ]

        # Clear NO answers
        no_words = [
            "no",
            "nope",
            "n",
            "false"
        ]

        if answer in yes_words:
            return True

        if answer in no_words:
            return False

        # Natural language YES
        yes_phrases = [
            "he is conscious",
            "she is conscious",
            "they are conscious",
            "he is responding",
            "she is responding",
            "they are responding",
            "he is breathing",
            "she is breathing",
            "they are breathing",
            "yes he is",
            "yes she is",
            "yes they are"
        ]

        # Natural language NO
        no_phrases = [
            "he is unconscious",
            "she is unconscious",
            "they are unconscious",
            "he is not responding",
            "she is not responding",
            "they are not responding",
            "he isn't responding",
            "she isn't responding",
            "they aren't responding",
            "he is not breathing",
            "she is not breathing",
            "they are not breathing",
            "he isn't breathing",
            "she isn't breathing",
            "they aren't breathing",
            "not responding",
            "unconscious",
            "not breathing"
        ]

        for phrase in yes_phrases:
            if phrase in answer:
                return True

        for phrase in no_phrases:
            if phrase in answer:
                return False

        return None

    def process_answer(self, key, answer):
        """
        Processes the answer according to the question type.
        """

        if key in ["conscious", "breathing", "severe_bleeding"]:
            return self.process_yes_no(answer)

        if key == "location":
            return answer.strip()

        return answer.strip()