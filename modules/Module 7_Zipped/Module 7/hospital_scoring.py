class HospitalScoring:

    def __init__(self):

        pass


    def score_hospital(
        self,
        hospital,
        incident_type
    ):

        score = 0

        specialties = str(
            hospital.get(
                "specialties",
                ""
            )
        ).lower()

        facilities = str(
            hospital.get(
                "facilities",
                ""
            )
        ).lower()

        emergency_services = str(
            hospital.get(
                "emergency_services",
                ""
            )
        ).lower()


        # --------------------------------
        # Emergency service
        # --------------------------------

        if (
            "yes" in emergency_services
            or
            "emergency" in emergency_services
        ):

            score += 30


        # --------------------------------
        # Incident-specific scoring
        # --------------------------------

        incident = incident_type.lower()


        # Cardiac emergency
        if (
            "cardiac" in incident
            or
            "heart" in incident
            or
            "chest" in incident
        ):

            if (
                "cardio" in specialties
                or
                "cardiology" in specialties
            ):

                score += 40


        # Accident / trauma
        elif (
            "accident" in incident
            or
            "trauma" in incident
            or
            "injury" in incident
        ):

            if "trauma" in specialties:

                score += 40

            if "emergency" in facilities:

                score += 20


        # Stroke
        elif "stroke" in incident:

            if (
                "neurology" in specialties
                or
                "neurolog" in facilities
            ):

                score += 40


        # General emergency
        else:

            if "hospital" in str(
                hospital.get(
                    "hospital_care_type",
                    ""
                )
            ).lower():

                score += 20


        # --------------------------------
        # Bed availability
        # --------------------------------

        try:

            beds = float(
                hospital.get(
                    "total_num_beds",
                    0
                )
            )

            if beds > 100:

                score += 20

            elif beds > 50:

                score += 15

            elif beds > 0:

                score += 10

        except (ValueError, TypeError):

            pass


        # --------------------------------
        # Distance
        # --------------------------------

        distance = hospital.get(
            "distance_km",
            999
        )

        try:

            distance = float(distance)

        except (ValueError, TypeError):

            distance = 999


        if distance <= 5:

            score += 30

        elif distance <= 10:

            score += 20

        elif distance <= 20:

            score += 10


        return score


    def rank_hospitals(
        self,
        hospitals,
        incident_type
    ):

        results = []

        for _, hospital in hospitals.iterrows():

            score = self.score_hospital(
                hospital,
                incident_type
            )

            hospital_info = hospital.to_dict()

            hospital_info[
                "suitability_score"
            ] = score

            results.append(
                hospital_info
            )


        results.sort(
            key=lambda x:
                x["suitability_score"],
            reverse=True
        )

        return results