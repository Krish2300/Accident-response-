class QuestionManager:

    def __init__(self):
        self.questions = [
            {
                "key": "conscious",
                "question": "Is the person conscious and responding?"
            },
            {
                "key": "breathing",
                "question": "Is the person breathing normally?"
            },
            {
                "key": "severe_bleeding",
                "question": "Is there any severe bleeding?"
            },
            {
                "key": "location",
                "question": "What is the current location of the person?"
            }
        ]

    def get_next_question(self, patient_data):
        """
        Finds the first question whose answer is still unknown.
        """

        for question in self.questions:

            key = question["key"]

            if patient_data.get(key) is None:
                return question

        return None

    def get_all_questions(self):
        return self.questions