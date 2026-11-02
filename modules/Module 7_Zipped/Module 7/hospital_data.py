import pandas as pd


class HospitalData:

    def __init__(self, dataset_file):

        print("Loading hospital dataset...")

        self.data = pd.read_csv(
            dataset_file,
            low_memory=False
        )

        # Normalize column names
        self.data.columns = (
            self.data.columns
            .str.strip()
            .str.lower()
            .str.replace(" ", "_")
        )

        print("Dataset loaded successfully.")
        print("Total hospitals:", len(self.data))

        print()
        print("Columns detected:")
        print(list(self.data.columns))

    def get_hospitals(self):
        return self.data

    def search_by_state(self, state):

        result = self.data[
            self.data["state"]
            .astype(str)
            .str.lower()
            .str.contains(
                state.lower(),
                na=False
            )
        ]

        return result