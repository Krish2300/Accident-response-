from patient_state import PatientState
from question_manager import QuestionManager
from answer_processor import AnswerProcessor


class ConversationEngine:

    def __init__(self):
        self.patient = PatientState()
        self.question_manager = QuestionManager()
        self.answer_processor = AnswerProcessor()

    def load_incident_data(self, incident_data):
        """
        Receives initial information from Module 3.
        """

        self.patient.load_incident_data(incident_data)

    def get_next_question(self):
        """
        Finds the next unanswered question.
        """

        patient_data = self.patient.get_all()

        return self.question_manager.get_next_question(patient_data)

    def process_answer(self, key, answer):
        """
        Processes the response and updates patient information.
        """

        value = self.answer_processor.process_answer(key, answer)

        if value is None:
            return False

        self.patient.update(key, value)

        return True

    def get_patient_data(self):
        """
        Returns the completed patient information.
        """

        return self.patient.get_all()

    def is_complete(self):
        """
        Checks whether all required information is available.
        """

        return self.patient.is_complete()