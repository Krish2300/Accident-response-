import math
import re
import pandas as pd


class HospitalSearch:

    def __init__(self, hospital_data):
        self.data = hospital_data.copy()

    def calculate_distance(self, lat1, lon1, lat2, lon2):
        """Calculate distance between two coordinates in kilometers."""

        R = 6371  # Earth radius in km

        lat1 = math.radians(lat1)
        lat2 = math.radians(lat2)

        dlat = lat2 - lat1
        dlon = math.radians(lon2 - lon1)

        a = (
            math.sin(dlat / 2) ** 2
            + math.cos(lat1)
            * math.cos(lat2)
            * math.sin(dlon / 2) ** 2
        )

        c = 2 * math.atan2(
            math.sqrt(a),
            math.sqrt(1 - a)
        )

        return R * c

    def extract_coordinates(self, value):
        """
        Extract latitude and longitude from the
        Location_Coordinates column.
        """

        if pd.isna(value):
            return None, None

        value = str(value).strip()

        if value == "":
            return None, None

        # Find numbers from the coordinate string
        numbers = re.findall(
            r"-?\d+(?:\.\d+)?",
            value
        )

        if len(numbers) < 2:
            return None, None

        try:
            latitude = float(numbers[0])
            longitude = float(numbers[1])

            # Validate latitude
            if not -90 <= latitude <= 90:
                return None, None

            # Validate longitude
            if not -180 <= longitude <= 180:
                return None, None

            return latitude, longitude

        except ValueError:
            return None, None

    def find_nearby_hospitals(
        self,
        latitude,
        longitude,
        max_distance=30
    ):
        """
        Find hospitals within the specified distance.
        """

        hospitals = []

        valid_coordinates = 0

        for _, hospital in self.data.iterrows():

            coordinates = hospital.get(
                "location_coordinates",
                ""
            )

            hospital_lat, hospital_lon = (
                self.extract_coordinates(coordinates)
            )

            if hospital_lat is None or hospital_lon is None:
                continue

            valid_coordinates += 1

            distance = self.calculate_distance(
                latitude,
                longitude,
                hospital_lat,
                hospital_lon
            )

            if distance <= max_distance:

                hospital_info = hospital.to_dict()

                hospital_info["hospital_latitude"] = hospital_lat
                hospital_info["hospital_longitude"] = hospital_lon
                hospital_info["distance_km"] = round(
                    distance,
                    2
                )

                hospitals.append(hospital_info)

        print()
        print(
            "Valid hospital coordinates found:",
            valid_coordinates
        )

        if not hospitals:

            print()
            print(
                f"No hospitals found within "
                f"{max_distance} km."
            )

            return pd.DataFrame()

        result = pd.DataFrame(hospitals)

        # Sort nearest hospital first
        result = result.sort_values(
            by="distance_km"
        )

        return result.reset_index(drop=True)