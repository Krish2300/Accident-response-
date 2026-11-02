import os
import requests


DATA_FOLDER = "data"
DATASET_FILE = os.path.join(
    DATA_FOLDER,
    "hospitals.csv"
)

# Official data.gov.in resource
RESOURCE_ID = "98fa254e-c5f8-4910-a19b-4828939b477d"

DOWNLOAD_URL = (
    "https://www.data.gov.in/sites/default/files/"
    "datafile/"
    "hospital_directory.csv"
)


def download_dataset():

    os.makedirs(
        DATA_FOLDER,
        exist_ok=True
    )

    # If a valid dataset already exists,
    # don't download it again.
    if os.path.exists(DATASET_FILE):

        file_size = os.path.getsize(
            DATASET_FILE
        )

        if file_size > 100000:

            print(
                "Hospital dataset already exists."
            )

            return DATASET_FILE

        else:

            print(
                "Existing dataset looks invalid."
            )

            os.remove(DATASET_FILE)


    print(
        "Downloading hospital dataset..."
    )

    print(
        "Please wait..."
    )


    try:

        response = requests.get(
            DOWNLOAD_URL,
            timeout=60,
            headers={
                "User-Agent":
                "Mozilla/5.0"
            }
        )

        response.raise_for_status()


        # --------------------------------
        # Check whether we actually got CSV
        # --------------------------------

        content_type = response.headers.get(
            "Content-Type",
            ""
        ).lower()


        first_bytes = response.content[:500].lower()


        # Detect HTML page
        if (
            "text/html" in content_type
            or
            b"<html" in first_bytes
            or
            b"<!doctype" in first_bytes
        ):

            print()
            print(
                "ERROR: The server returned an HTML page"
            )

            print(
                "instead of the CSV dataset."
            )

            print()
            print(
                "The dataset download URL needs"
            )

            print(
                "to be updated."
            )

            return None


        # --------------------------------
        # Save CSV
        # --------------------------------

        with open(
            DATASET_FILE,
            "wb"
        ) as file:

            file.write(
                response.content
            )


        file_size = os.path.getsize(
            DATASET_FILE
        )


        print()
        print(
            "Hospital dataset downloaded!"
        )

        print(
            "File size:",
            round(
                file_size / (1024 * 1024),
                2
            ),
            "MB"
        )


        return DATASET_FILE


    except requests.RequestException as error:

        print()
        print(
            "Dataset download failed."
        )

        print(
            "Error:",
            error
        )

        return None


if __name__ == "__main__":

    download_dataset()