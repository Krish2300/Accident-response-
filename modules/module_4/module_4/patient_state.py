class PatientState:

    def __init__(self):
        self.data = {
            "incident_type": None,
            "location": None,
            "conscious": None,
            "breathing": None,
            "severe_bleeding": None
        }

    def load_incident_data(self, incident_data):
        """
        Receives initial information from Module 3.
        """

        for key, value in incident_data.items():

            if key in self.data:
                self.data[key] = value

    def update(self, key, value):
        self.data[key] = value

    def get(self, key):
        return self.data.get(key)

    def get_all(self):
        return self.data

    def is_complete(self):
        return all(value is not None for value in self.data.values())