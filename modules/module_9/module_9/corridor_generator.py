class CorridorGenerator:

    def __init__(self, width=0.001):
        self.width = width

    def create_corridor(self, route):
        """
        Creates an emergency corridor around the ambulance route.
        """

        corridor = []

        for latitude, longitude in route:

            area = {
                "min_latitude": latitude - self.width,
                "max_latitude": latitude + self.width,
                "min_longitude": longitude - self.width,
                "max_longitude": longitude + self.width
            }

            corridor.append(area)

        return corridor