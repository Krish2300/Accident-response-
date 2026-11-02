class Geofence:

    def is_inside(self, latitude, longitude, area):
        """
        Checks whether a user's location is inside
        an emergency corridor area.
        """

        return (
            area["min_latitude"] <= latitude <= area["max_latitude"]
            and
            area["min_longitude"] <= longitude <= area["max_longitude"]
        )