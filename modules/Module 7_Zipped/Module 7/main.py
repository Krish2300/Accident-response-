from download_dataset import download_dataset
from hospital_data import HospitalData
from hospital_search import HospitalSearch
from hospital_scoring import HospitalScoring


def main():

    print()
    print("==========================================")
    print("       EMERGENCY HOSPITAL INTELLIGENCE")
    print("              MODULE 7")
    print("==========================================")
    print()


    # ---------------------------------------
    # STEP 1
    # Download dataset
    # ---------------------------------------

    dataset_file = download_dataset()

    if dataset_file is None:

        print(
            "Dataset download failed."
        )

        return


    # ---------------------------------------
    # STEP 2
    # Load hospital dataset
    # ---------------------------------------

    hospital_database = HospitalData(
        dataset_file
    )

    hospitals = (
        hospital_database
        .get_hospitals()
    )


    # ---------------------------------------
    # STEP 3
    # Get emergency information
    # ---------------------------------------

    print()
    print("Enter emergency details")
    print("------------------------------------------")

    incident_type = input(
        "Incident type "
        "(cardiac/accident/stroke/general): "
    )

    latitude = float(
        input(
            "Emergency latitude: "
        )
    )

    longitude = float(
        input(
            "Emergency longitude: "
        )
    )


    # ---------------------------------------
    # STEP 4
    # Find nearby hospitals
    # ---------------------------------------

    search = HospitalSearch(
        hospitals
    )

    nearby_hospitals = (
        search.find_nearby_hospitals(
            latitude,
            longitude,
            max_distance=30
        )
    )


    if nearby_hospitals.empty:

        print()
        print(
            "No hospitals found within 30 km."
        )

        return


    print()
    print(
        "Nearby hospitals found:",
        len(nearby_hospitals)
    )


    # ---------------------------------------
    # STEP 5
    # Score hospitals
    # ---------------------------------------

    scoring = HospitalScoring()

    ranked_hospitals = (
        scoring.rank_hospitals(
            nearby_hospitals,
            incident_type
        )
    )


    # ---------------------------------------
    # STEP 6
    # Display results
    # ---------------------------------------

    print()
    print("==========================================")
    print("       HOSPITAL SUITABILITY RESULTS")
    print("==========================================")

    for number, hospital in enumerate(
        ranked_hospitals[:5],
        start=1
    ):

        print()
        print(
            f"{number}.",
            hospital.get(
                "hospital_name",
                "Unknown"
            )
        )

        print(
            "   Distance:",
            hospital.get(
                "distance_km",
                "Unknown"
            ),
            "km"
        )

        print(
            "   Suitability Score:",
            hospital.get(
                "suitability_score",
                0
            )
        )

        print(
            "   State:",
            hospital.get(
                "state",
                "Unknown"
            )
        )

        print(
            "   District:",
            hospital.get(
                "district",
                "Unknown"
            )
        )

        print(
            "   Specialties:",
            hospital.get(
                "specialties",
                "Unknown"
            )
        )


    # ---------------------------------------
    # STEP 7
    # Selected hospital
    # ---------------------------------------

    selected = ranked_hospitals[0]

    print()
    print("==========================================")
    print("          SELECTED HOSPITAL")
    print("==========================================")

    print(
        "Hospital:",
        selected.get(
            "hospital_name",
            "Unknown"
        )
    )

    print(
        "Distance:",
        selected.get(
            "distance_km",
            "Unknown"
        ),
        "km"
    )

    print(
        "Suitability:",
        selected.get(
            "suitability_score",
            0
        )
    )

    print()
    print(
        "Module 7 completed successfully."
    )


if __name__ == "__main__":

    main()